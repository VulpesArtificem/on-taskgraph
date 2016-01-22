// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di');
module.exports = taskRunnerFactory;
di.annotate(taskRunnerFactory, new di.Provide('TaskGraph.TaskRunner'));
di.annotate(taskRunnerFactory,
    new di.Inject(
        'Logger',
        'Promise',
        'Constants',
        'Assert',
        'uuid',
        '_',
        'Rx',
        'Task.Task',
        'Task.Messenger',
        'TaskGraph.Store'
    )
);

function taskRunnerFactory(
    Logger,
    Promise,
    Constants,
    assert,
    uuid,
    _,
    Rx,
    Task,
    taskMessenger,
    store
) {
    var logger = Logger.initialize(taskRunnerFactory);

    function TaskRunner(options) {
        options = options || {};
        this.taskRunnerId = uuid.v4();
        this.runTaskStream = new Rx.Subject();
        this.cancelTaskStream = new Rx.Subject();
        this.pipelines = null;
        this.heartbeatInterval = options.heartbeatInterval || 500;
        this.running = false;
        this.activeTasks = {};
        this.domain = options.domain || Constants.DefaultTaskDomain;
    }

    TaskRunner.prototype.isRunning = function() {
        return this.running;
    };

    TaskRunner.prototype.initializePipeline = function() {
        var self = this;
        var runTaskSubscription = self.createRunTaskSubscription(self.runTaskStream);
        var heartbeatSubscription = self.createHeartbeatSubscription();
        var taskCancelSubscription = self.createCancelTaskSubscription(self.cancelTaskStream);

        return [
            runTaskSubscription,
            heartbeatSubscription,
            taskCancelSubscription
        ];
    };

    TaskRunner.prototype.subscribeRunTask = function() {
        return taskMessenger.subscribeRunTask(
                this.domain,
                this.runTaskStream.onNext.bind(this.runTaskStream)
            );
    };

    TaskRunner.prototype.subscribeCancel = function() {
        return taskMessenger.subscribeCancel(
                this.cancelTaskStream.onNext.bind(this.cancelTaskStream)
            );
    };

    TaskRunner.prototype.createRunTaskSubscription = function(runTaskStream) {
        var self = this;
        return runTaskStream
            .takeWhile(self.isRunning.bind(self))
            .flatMap(safeStream.bind(self, store.checkoutTask.bind(store, self.taskRunnerId),
                        'Error while checking out task'))
            .tap(function(data) {
                if (data) {logger.debug('Starting new task', {data: data});} else
                { logger.debug('checked nothing out');}
            })
            .filter(function(data) { return !_.isEmpty(data);})
            .flatMap(safeStream.bind(self, store.getTaskById, 'Error while getting task data'))
            .flatMap(safeStream.bind(self, self.runTask.bind(self), 'Error while running task'))
            .subscribe(
                self.handleStreamSuccess.bind(self, 'Task finished'),
                self.handleStreamError.bind(self, 'Task failure')
            );
    };

    TaskRunner.prototype.createCancelTaskSubscription = function(cancelTaskStream) {
        var self = this;
        return cancelTaskStream
            .takeWhile(self.isRunning.bind(self))
            .flatMap(safeStream.bind(self, self.cancelTask.bind(self),
                        'Error while cancelling task')
            )
            .subscribe(
                self.handleStreamSuccess.bind(self, 'Task cancelled'),
                self.handleStreamError.bind(self, 'Task cancellation error')
            );
    };

    TaskRunner.prototype.cancelTask = function(data) {
        var self = this;
        return Rx.Observable.just(data)
            .map(function(taskData) {
                return self.activeTasks[taskData.taskId];
            })
            .filter(function(task) { return !_.isEmpty(task); })
            .tap(function(task) {
                logger.debug('Cancelling task', {data: task.toJSON()});
            })
            .flatMap(function(task) { return task.cancel(); })
            .finally(function() {
                delete self.activeTasks[data.taskId];
            });
    };

    var safeStream = function(toObserve, msg, streamData) {
        var self = this;
        return Rx.Observable.just(streamData)
            .flatMap(toObserve)
            .catch(self.handleStreamError.bind(self,
                        msg || 'An Error occured in the task stream'));
    };

    TaskRunner.prototype.createHeartbeatSubscription = function() {
        var self = this;
        return Rx.Observable.interval(self.heartbeatInterval)
                .takeWhile(self.isRunning.bind(self))
                .flatMap(store.heartbeatTasksForRunner.bind(store, self.taskRunnerId))
                .tap(function(stuff) {
                    console.log('ID: ', self.taskRunnerId , ' heartbeat return: ',
                            stuff,
                            ' activeTasks: ',
                            Object.keys(self.activeTasks).length);
                })
                .filter(function(taskCount) {
                    return taskCount !== Object.keys(self.activeTasks).length;
                })
                .flatMap(safeStream.bind(self,
                            self.cancelUnownedTasks.bind(self),
                            'Error cancelling unowned tasks'
                            )
                )
                .catch(function(error) {
                    logger.error('Failed to update heartbeat, stopping task runner and tasks', {
                        taskRunnerId: self.taskRunnerId,
                        error: error,
                        activeTasks: _.keys(self.activeTasks)
                    });
                    return Rx.Observable.just(self.stop.bind(self)());
                })
                .subscribe(
                    self.handleStreamSuccess.bind(self, null),
                    self.handleStreamError.bind(self, 'Error handling heartbeat failure')
                );
    };

    TaskRunner.prototype.cancelUnownedTasks = function() {
        var self = this;
        return Rx.Observable.fromPromise(store.getOwnTasks(self.taskRunnerId))
            .map(function(stuff) {
                console.log('active tasks ', Object.keys(self.activeTasks), ' heart tasks ', _.pluck(stuff, 'taskId'));
                return _.difference(self.activeTasks, _.pluck(stuff, 'taskId'))
                    .forEach(function(taskId) {
                        console.log('cancelling ', taskId);
                        self.activeTasks[taskId].cancel();
                });
            });
    };

    TaskRunner.prototype.handleStreamSuccess = function(msg, data) {
        if (msg) {
            if (data && !data.taskRunnerId) {
                data.taskRunnerId = this.taskRunnerId;
            }
            logger.debug(msg, data);
        }
        return Rx.Observable.empty();
    };

    TaskRunner.prototype.handleStreamError = function(msg, err) {
        logger.error(msg, {
            taskRunnerId: this.taskRunnerId,
            // stacks on some error objects don't get printed if part of
            // the error object so separate them out here
            error: _.omit(err, 'stack'),
            stack: err.stack
        });
        return Rx.Observable.empty();
    };

    TaskRunner.prototype.runTask = function(data) {
        var self = this;
        return Rx.Observable.just(data)
            .map(function(_data) {
                return Task.create(
                    _data.task,
                    { instanceId: _data.task.instanceId },
                    _data.context
                );
            })
            .tap(function(task) {
                self.activeTasks[task.instanceId] = task;
            })
            .tap(function(task) {
                logger.debug("Running task ", {
                    taskRunnerId: self.taskRunnerId,
                    taskId: task.instanceId,
                    taskName: task.definition.injectableName
                });
            })
            .flatMap(function(task) {
                return task.run();
            })
            .flatMap(function(task) {
                return Rx.Observable.forkJoin([
                    Rx.Observable.just(task),
                    store.setTaskState(task.instanceId, task.context.graphId, task.state)
                ]);
            })
            .map(_.first)
            .tap(self.publishTaskFinished.bind(self))
            .map(function(task) { return _.pick(task, ['instanceId', 'state']); })
            .finally(function() {
                delete self.activeTasks[data.task.instanceId];
            });
    };

    TaskRunner.prototype.publishTaskFinished = function(task) {
        return taskMessenger.publishTaskFinished(
            this.domain, task.instanceId, task.context.graphId, task.state
        )
        .catch(function(error) {
            logger.error('Error publishing task finished event', {
                taskId: task.instanceId,
                graphId: task.context.graphId,
                state: task.state,
                error: error
            });
        });
    };

    TaskRunner.prototype.stop = function() {
        try {
            this.running = false;
            while (!_.isEmpty(this.pipelines)) {
                this.pipelines.pop().dispose();
            }
        } catch (e) {
            logger.error('Failed to stop task runner', {
                taskRunnerId: this.taskRunnerId,
                error: e
            });
        }
    };

    TaskRunner.prototype.start = function() {
        var self = this;
        return Promise.resolve()
        .then(function() {
            self.running = true;
            self.pipelines = self.initializePipeline();
            return self.subscribeCancel()
                .then(self.subscribeRunTask.bind(self));
        })
        .then(function() {
            logger.info('Task runner started', {
                TaskRunnerId: self.taskRunnerId,
                domain: self.domain
            });
        });
    };

    TaskRunner.create = function() {
        return new TaskRunner();
    };

    return TaskRunner;
}
