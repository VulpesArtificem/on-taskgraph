// Copyright 2016, EMC, Inc.

'use strict';

describe('Task Scheduler', function() {
    var TaskScheduler;
    var TaskGraph;
    var LeaseExpirationPoller;
    var taskMessenger;
    var store;
    var assert;
    var Constants;
    var Promise;
    var Rx;

    var asyncAssertWrapper = function(done, cb) {
        return function(data) {
            try {
                cb(data);
                done();
            } catch (e) {
                done(e);
            }
        };
    };

    var streamSuccessWrapper = function(stream, done, cb) {
        stream.subscribe(
            asyncAssertWrapper(done, cb),
            done,
            function() { }
        );
    };

    var streamCompletedWrapper = function(stream, done, cb) {
        stream.subscribe(
            function () {},
            done,
            asyncAssertWrapper(done, cb)
        );
    };


    before(function() {
        var di = require('di');
        var tasks = require('on-tasks');
        var core = require('on-core')(di, __dirname);

        helper.setupInjector(_.flattenDeep([
            core.workflowInjectables,
            tasks.injectables,
            require('../../lib/task-scheduler'),
            require('../../lib/lease-expiration-poller'),
            require('../../lib/rx-mixins')
        ]));
        assert = helper.injector.get('Assert');
        Constants = helper.injector.get('Constants');
        taskMessenger = helper.injector.get('Task.Messenger');
        TaskScheduler = helper.injector.get('TaskGraph.TaskScheduler');
        TaskGraph = helper.injector.get('TaskGraph.TaskGraph');
        LeaseExpirationPoller = helper.injector.get('TaskGraph.LeaseExpirationPoller');
        store = helper.injector.get('TaskGraph.Store');
        Rx = helper.injector.get('Rx');
        Promise = helper.injector.get('Promise');
        this.sandbox = sinon.sandbox.create();
    });

    beforeEach(function() {
        this.sandbox.spy(TaskScheduler.prototype, 'handleStreamError');
        this.sandbox.spy(TaskScheduler.prototype, 'handleStreamSuccess');
        this.sandbox.stub(taskMessenger, 'subscribeRunTaskGraph').resolves({});
        this.sandbox.stub(taskMessenger, 'subscribeTaskFinished').resolves({});
        this.sandbox.stub(LeaseExpirationPoller, 'create').returns({
            start: sinon.stub(),
            stop: sinon.stub()
        });
    });

    afterEach(function() {
        this.sandbox.restore();
    });

    describe('Task Scheduler', function() {
        var taskScheduler;

        beforeEach(function() {
            taskScheduler = TaskScheduler.create();
        });

        it('should be created with default values', function() {
            expect(taskScheduler.running).to.equal(false);
            expect(assert.uuid.bind(assert, taskScheduler.schedulerId)).to.not.throw(Error);
            expect(taskScheduler.domain).to.equal(Constants.DefaultTaskDomain);
            expect(taskScheduler.evaluateTaskStream).to.be.an.instanceof(Rx.Subject);
            expect(taskScheduler.evaluateGraphStream).to.be.an.instanceof(Rx.Subject);
            expect(taskScheduler.checkGraphFinishedStream).to.be.an.instanceof(Rx.Subject);
            expect(taskScheduler.pollInterval).to.equal(500);
            expect(taskScheduler.concurrencyMaximums).to.deep.equal(
                {
                    findReadyTasks: { count: 0, max: 100 },
                    updateTaskDependencies: { count: 0, max: 100 },
                    handleScheduleTaskEvent: { count: 0, max: 100 },
                    completeGraphs: { count: 0, max: 100 },
                    findUnevaluatedTasks: { count: 0, max: 1 }
                }
            );
            expect(taskScheduler.subscriptions).to.deep.equal([]);
            expect(taskScheduler.leasePoller).to.equal(null);
            expect(taskScheduler.debug).to.equal(false);
        });

        it('start', function() {
            var stub = sinon.stub();
            this.sandbox.stub(taskScheduler, 'subscribeRunTaskGraph').resolves(stub);
            this.sandbox.stub(taskScheduler, 'subscribeTaskFinished').resolves(stub);
            return taskScheduler.start()
            .then(function() {
                expect(taskScheduler.running).to.equal(true);
                expect(taskScheduler.leasePoller.running).to.equal(true);
                expect(taskScheduler.subscriptions).to.deep.equal([stub, stub]);
            });
        });


        it('stop', function() {
            var runTaskGraphDisposeStub = sinon.stub().resolves();
            var taskFinishedDisposeStub = sinon.stub().resolves();
            this.sandbox.stub(taskScheduler, 'subscribeRunTaskGraph').resolves({
                dispose: runTaskGraphDisposeStub
            });
            this.sandbox.stub(taskScheduler, 'subscribeTaskFinished').resolves({
                dispose: taskFinishedDisposeStub
            });
            return taskScheduler.start()
            .then(function() {
                return taskScheduler.stop();
            })
            .then(function() {
                expect(taskScheduler.running).to.equal(false);
                expect(taskScheduler.leasePoller.running).to.equal(false);
                expect(runTaskGraphDisposeStub).to.have.been.calledOnce;
                expect(taskFinishedDisposeStub).to.have.been.calledOnce;
            });
        });

        it('stream success handler should return an observable', function() {
            taskScheduler.handleStreamSuccess.restore();
            expect(taskScheduler.handleStreamSuccess()).to.be.an.instanceof(Rx.Observable);
        });

        it('stream error handler should return an empty observable', function() {
            taskScheduler.handleStreamError.restore();
            expect(taskScheduler.handleStreamError('test', {})).to.be.an.instanceof(Rx.Observable);
        });

        describe('createTasksToScheduleSubscription', function() {
            var subscription;

            beforeEach(function() {
                this.sandbox.stub(store, 'findReadyTasks');

                taskScheduler = TaskScheduler.create();
                taskScheduler.running = true;

                this.sandbox.stub(taskScheduler, 'findReadyTasks');
                this.sandbox.stub(taskScheduler, 'handleScheduleTaskEvent');
                this.sandbox.stub(taskScheduler, 'publishScheduleTaskEvent');
            });

            it('should not flow if scheduler is not running', function(done) {
                store.findReadyTasks.resolves({});
                taskScheduler.subscriptions = [];
                var evaluateGraphStream = new Rx.Subject();
                subscription = taskScheduler.createTasksToScheduleSubscription(evaluateGraphStream);

                return taskScheduler.stop()
                .then(function() {
                    streamCompletedWrapper(subscription, done, function() {
                        expect(store.findReadyTasks).to.not.have.been.called;
                    });
                    evaluateGraphStream.onNext();
                });
            });

            it('should filter if no tasks are found', function(done) {
                taskScheduler.findReadyTasks.resolves([]);
                taskScheduler.handleScheduleTaskEvent.resolves({});
                subscription = taskScheduler.createTasksToScheduleSubscription(
                    Rx.Observable.just());

                streamCompletedWrapper(subscription, done, function() {
                    expect(taskScheduler.handleScheduleTaskEvent).to.not.have.been.called;
                });
            });

            it('should schedule ready tasks for a graph', function(done) {
                var task = {
                    domain: taskScheduler.domain,
                    graphId: 'testgraphid',
                    taskId: 'testtaskid'
                };
                var result = {
                    tasks: [task, task, task]
                };
                taskScheduler.findReadyTasks.restore();
                store.findReadyTasks.resolves(result);
                taskScheduler.handleScheduleTaskEvent.resolves({});
                subscription = taskScheduler.createTasksToScheduleSubscription(
                    Rx.Observable.just({ graphId: 'testgraphid' }));

                streamCompletedWrapper(subscription, done, function() {
                    expect(store.findReadyTasks).to.have.been.calledOnce;
                    expect(store.findReadyTasks).to.have.been.calledWith(
                        taskScheduler.domain, 'testgraphid');
                    expect(taskScheduler.handleScheduleTaskEvent).to.have.been.calledThrice;
                    expect(taskScheduler.handleScheduleTaskEvent).to.have.been.calledWith(task);
                });
            });

            it('should handle handleScheduleTaskEvent errors', function(done) {
                var testError = new Error('test handleScheduleTaskEvent error');
                taskScheduler.findReadyTasks.resolves({ tasks: [{}] });
                taskScheduler.handleScheduleTaskEvent.restore();
                taskScheduler.publishScheduleTaskEvent.rejects(testError);
                subscription = taskScheduler.createTasksToScheduleSubscription(
                    Rx.Observable.just());

                streamCompletedWrapper(subscription, done, function() {
                    expect(taskScheduler.handleStreamError).to.have.been.calledWith(
                        'Error scheduling task',
                        testError
                    );
                });
            });

            it('should handle findReadyTasks errors', function(done) {
                var testError = new Error('test findReadyTasks error');
                taskScheduler.findReadyTasks.restore();
                store.findReadyTasks.rejects(testError);
                subscription = taskScheduler.createTasksToScheduleSubscription(
                    Rx.Observable.just({ graphId: 'testgraphid' }));

                streamCompletedWrapper(subscription, done, function() {
                    expect(taskScheduler.handleStreamError).to.have.been.calledWith(
                        'Error finding ready tasks',
                        testError
                    );
                });
            });
        });
    });

    describe('createUpdateTaskDependenciesSubscription', function() {
        var taskScheduler;
        var taskHandlerStream;
        var subscription;
        var checkGraphFinishedStream;
        var evaluateGraphStream;

        beforeEach(function() {
            this.sandbox.stub(store, 'setTaskStateInGraph').resolves();
            this.sandbox.stub(store, 'updateDependentTasks').resolves();
            this.sandbox.stub(store, 'updateUnreachableTasks').resolves();
            this.sandbox.stub(store, 'markTaskEvaluated');

            taskHandlerStream = new Rx.Subject();
            evaluateGraphStream = new Rx.Subject();
            checkGraphFinishedStream = new Rx.Subject();
            this.sandbox.spy(evaluateGraphStream, 'onNext');
            this.sandbox.spy(checkGraphFinishedStream, 'onNext');

            taskScheduler = TaskScheduler.create();
            taskScheduler.running = true;

            subscription = taskScheduler.createUpdateTaskDependenciesSubscription(
                taskHandlerStream,
                evaluateGraphStream,
                checkGraphFinishedStream
            );
        });

        afterEach(function() {
            taskHandlerStream.dispose();
            evaluateGraphStream.dispose();
            checkGraphFinishedStream.dispose();
        });

        it('should not flow if scheduler is not running', function(done) {
            this.sandbox.stub(taskScheduler, 'updateTaskDependencies');
            taskScheduler.subscriptions = [];

            return taskScheduler.stop()
            .then(function() {
                streamCompletedWrapper(subscription, done, function() {
                    expect(taskScheduler.updateTaskDependencies).to.not.have.been.called;
                });
                taskHandlerStream.onNext({});
            });
        });

        it('should check if a graph is finished on a terminal task state', function(done) {
            var data = {
                terminalOnStates: ['succeeded'],
                state: 'succeeded'
            };
            store.markTaskEvaluated.resolves(data);

            streamSuccessWrapper(subscription, done, function() {
                expect(checkGraphFinishedStream.onNext).to.have.been.calledOnce;
                expect(checkGraphFinishedStream.onNext).to.have.been.calledWith(data);
            });

            taskHandlerStream.onNext({});
        });

        it('should check for ready tasks in a graph if a task is non-terminal', function(done) {
            var data = {
                terminalOnStates: ['failed'],
                state: 'succeeded',
                graphId: 'testgraphid'
            };
            store.markTaskEvaluated.resolves(data);

            streamSuccessWrapper(subscription, done, function() {
                expect(evaluateGraphStream.onNext).to.have.been.calledOnce;
                expect(evaluateGraphStream.onNext).to.have.been.calledWith({
                    graphId: 'testgraphid'
                });
            });

            taskHandlerStream.onNext({});
        });

        it('should handle errors related to updating task dependencies', function(done) {
            var testError = new Error('test update dependencies error');
            store.setTaskStateInGraph.rejects(testError);

            subscription = taskScheduler.createUpdateTaskDependenciesSubscription(
                Rx.Observable.just({}),
                evaluateGraphStream,
                checkGraphFinishedStream
            );

            streamCompletedWrapper(subscription, done, function() {
                expect(taskScheduler.handleStreamError).to.have.been.calledOnce;
                expect(taskScheduler.handleStreamError).to.have.been.calledWith(
                    'Error updating task dependencies',
                    testError);
            });
        });
    });

    describe('createCheckGraphFinishedSubscription', function() {
        var taskScheduler;
        var checkGraphFinishedStream;
        var subscription;

        beforeEach(function() {
            this.sandbox.stub(store, 'setGraphDone');
            checkGraphFinishedStream = new Rx.Subject();
            taskScheduler = TaskScheduler.create();
            taskScheduler.running = true;
            this.sandbox.stub(taskScheduler, 'checkGraphSucceeded');
            this.sandbox.stub(taskScheduler, 'failGraph');
        });

        it('should not flow if scheduler is not running', function(done) {
            taskScheduler.subscriptions = [];
            subscription = taskScheduler.createCheckGraphFinishedSubscription(
                checkGraphFinishedStream);

            return taskScheduler.stop()
            .then(function() {
                streamCompletedWrapper(subscription, done, function() {
                    expect(taskScheduler.checkGraphSucceeded).to.not.have.been.called;
                    expect(taskScheduler.failGraph).to.not.have.been.called;
                });
                checkGraphFinishedStream.onNext({});
            });
        });

        afterEach(function() {
            checkGraphFinishedStream.dispose();
        });

        it('should check if a graph is succeeded on a succeeded task state', function(done) {
            var data = {
                taskId: 'testtaskid',
                state: Constants.TaskStates.Failed
            };
            taskScheduler.failGraph.resolves();
            subscription = taskScheduler.createCheckGraphFinishedSubscription(
                checkGraphFinishedStream);

            streamSuccessWrapper(subscription, done, function() {
                expect(taskScheduler.failGraph).to.have.been.calledOnce;
                expect(taskScheduler.failGraph).to.have.been.calledWith(data);
            });

            checkGraphFinishedStream.onNext(data);
        });

        it('should fail a graph on a terminal, failed task state', function(done) {
            var data = {
                taskId: 'testtaskid',
                state: Constants.TaskStates.Succeeded
            };
            taskScheduler.checkGraphSucceeded.resolves();
            subscription = taskScheduler.createCheckGraphFinishedSubscription(
                checkGraphFinishedStream);

            streamSuccessWrapper(subscription, done, function() {
                expect(taskScheduler.checkGraphSucceeded).to.have.been.calledOnce;
                expect(taskScheduler.checkGraphSucceeded).to.have.been.calledWith(data);
            });

            checkGraphFinishedStream.onNext(data);
        });

        it('should handle failGraph errors', function(done) {
            var data = {
                taskId: 'testtaskid',
                state: Constants.TaskStates.Failed
            };
            var testError = new Error('test fail graph error');
            store.setGraphDone.rejects(testError);
            taskScheduler.failGraph.restore();
            subscription = taskScheduler.createCheckGraphFinishedSubscription(
                Rx.Observable.just(data));

            streamCompletedWrapper(subscription, done, function() {
                expect(taskScheduler.handleStreamError).to.have.been.calledOnce;
                expect(taskScheduler.handleStreamError).to.have.been.calledWith(
                    'Error failing graph',
                    testError
                );
            });
        });
    });
});
