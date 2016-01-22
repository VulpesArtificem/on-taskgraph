// Copyright 2015, EMC, Inc.
/* jslint node: true */

"use strict";

var di = require('di');

module.exports = SubscriberFactory;

di.annotate(SubscriberFactory, new di.Provide('TaskGraph.Subscriptions'));
di.annotate(SubscriberFactory, new di.Inject(
        'Protocol.TaskGraphRunner',
        'TaskGraph.Registry',
        'TaskGraph.TaskGraph',
        'TaskGraph.TaskScheduler',
        'Task.Task',
        'Assert',
        'Errors',
        'Promise',
        '_'
    )
);

function SubscriberFactory(
    tgrProtocol,
    registry,
    TaskGraph,
    taskScheduler,
    Task,
    assert,
    Errors,
    Promise,
    _
) {
    function Subscriber() {
        this.subscriptions = [];
    }

    Subscriber.prototype.start = function start() {
        var self = this;
        return Promise.all([
            tgrProtocol.subscribeGraphCollectionUpdates(self.handleGraphStateChange),
            tgrProtocol.subscribeGetTaskGraphLibrary(self.getTaskGraphLibrary),
            tgrProtocol.subscribeGetTaskLibrary(self.getTaskLibrary),
            tgrProtocol.subscribeGetActiveTaskGraph(self.getActiveTaskGraph),
            tgrProtocol.subscribeGetActiveTaskGraphs(self.getActiveTaskGraphs),
            tgrProtocol.subscribeDefineTaskGraph(self.defineTaskGraph),
            tgrProtocol.subscribeDefineTask(self.defineTask),
            tgrProtocol.subscribeRunTaskGraph(self.runTaskGraph),
            tgrProtocol.subscribeCancelTaskGraph(self.cancelTaskGraph),
            tgrProtocol.subscribePauseTaskGraph(self.pauseTaskGraph),
            tgrProtocol.subscribeResumeTaskGraph(self.resumeTaskGraph)
        ])
        .spread(function() {
            _.forEach(arguments, function(subscription) {
                self.subscriptions.push(subscription);
            });
        });
    };

    Subscriber.prototype.stop = function stop() {
        var self = this;

        var taskGraphs = registry.fetchActiveGraphsSync();

        return Promise.all(_.map(taskGraphs, function(taskGraph) {
            return taskGraph.stop();
        })).then(function() {
            return Promise.all(_.map(self.subscriptions, function(subscription) {
                return subscription.dispose();
            }));
        })
        .then(function() {
            self.subscriptions = [];
        });
    };

    Subscriber.prototype.handleGraphStateChange = function(instanceId) {
        taskScheduler.graphtsToEvaluateStream.onNext(instanceId);
    };

    Subscriber.prototype.handleContextStateChange = function(id) {
        taskScheduler.externalContextStream.onNext(id);
    };

    Subscriber.prototype.getTaskGraphLibrary = function getTaskGraphLibrary(filter) {
        return registry.fetchGraphDefinitionCatalog(filter);
    };

    Subscriber.prototype.getTaskLibrary = function getTaskLibrary(filter) {
        return registry.fetchTaskDefinitionCatalog(filter);
    };

    Subscriber.prototype.getActiveTaskGraph = function getActiveTaskGraph(filter) {
        var graph = registry.fetchActiveGraphSync(filter);
        return graph ? graph.status() : undefined;
    };

    Subscriber.prototype.getActiveTaskGraphs = function getActiveTaskGraphs(filter) {
        var allRunning = registry.fetchActiveGraphsSync(filter);
        var _status = _.map(allRunning, function(i){return i.status();});
        return _status;
    };

    Subscriber.prototype.defineTask = function defineTask(definition) {
        try {
            assert.object(definition);
            assert.string(definition.injectableName);
            var taskObj = Task.createRegistryObject(definition);
            registry.registerTask(taskObj);
            return Promise.resolve(definition.injectableName);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    Subscriber.prototype.defineTaskGraph = function defineTaskGraph(definition) {
        try {
            assert.object(definition);
            assert.string(definition.injectableName);
            var graphObj = TaskGraph.createRegistryObject(definition);
            registry.registerGraph(graphObj);
            return Promise.resolve(definition.injectableName);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    Subscriber.prototype.runTaskGraph = function runTaskGraph(uniqueName, options, target) {
        var context = {};
        if (target) {
            context.target = target;
            var activeGraph = registry.hasActiveGraphSync(target);
            if (activeGraph) {
                return Promise.reject(new Errors.BadRequestError(
                            "Unable to run multiple task graphs against a single target."));
            }
        }

        return registry.fetchGraphDefinitionCatalog()
        .then(function(graphLibrary) {
            var exists = _.some(graphLibrary, function(definition) {
                return uniqueName === definition.injectableName ||
                        uniqueName === definition.friendlyName;
            });
            if (!exists) {
                throw new Error("Graph with name " + uniqueName + " does not exist.");
            }
            var taskGraph = registry.fetchGraphSync(uniqueName).create(options, context);
            // TODO: Make serializable errors that can get thrown on the other end
            // for the presenter, or at least some mechanism for doing HTTP errors here
            if (target) {
                registry.putActiveGraphSync(taskGraph, target);
            }
            return taskGraph.start();
        });
    };

    Subscriber.prototype.cancelTaskGraph = function cancelTaskGraph(filter) {
        var instance = registry.fetchActiveGraphSync(filter);
        if (instance) {
            var id = instance.instanceId;
            instance.cancel();
            return { instanceId: id };
        }
    };

    Subscriber.prototype.pauseTaskGraph = function pauseTaskGraph(filter) {
        var instance = registry.fetchActiveGraphSync(filter);
        assert.object(instance);
        instance.pause();
        var id = instance.instanceId;
        return { instanceId: id };
    };

    Subscriber.prototype.resumeTaskGraph = function resumeTaskGraph(filter) {
        var instance = registry.fetchActiveGraphSync(filter);
        assert.object(instance);
        instance.resume();
        var id = instance.instanceId;
        return { instanceId: id };
    };

    return new Subscriber();
}
