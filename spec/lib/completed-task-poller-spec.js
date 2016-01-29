// Copyright 2016, EMC, Inc.
/* jshint node:true */

'use strict';

describe("Task-runner", function() {
    var di = require('di');
    var core = require('on-core')(di, __dirname);

    var Poller,
        poller,
        Constants,
        Promise,
        eventsProtocol,
        store,
        Rx;

    var subscribeWrapper = function(done, cb) {
        return function(data) {
            try {
                cb(data);
                done();
            } catch (e) {
                done(e);
            }
        };
    };

    before(function() {
        helper.setupInjector([
            helper.require('/lib/completed-task-poller.js'),
            core.workflowInjectables
        ]);
        Rx = helper.injector.get('Rx');
        //Promise = helper.injector.get('Promise');
        Poller = helper.injector.get('TaskGraph.CompletedTaskPoller');
        eventsProtocol = helper.injector.get('Protocol.Events');
        store = helper.injector.get('TaskGraph.Store');
        Constants = helper.injector.get('Constants');
        Promise = helper.injector.get('Promise');
        this.sandbox = sinon.sandbox.create();
    });

    beforeEach(function() {
        this.sandbox.stub(store, 'findCompletedTasks').resolves();
        this.sandbox.stub(store, 'deleteTasks').resolves();
        this.sandbox.stub(store, 'setGraphDone').resolves();
        this.sandbox.stub(eventsProtocol, 'publishGraphFinished').resolves();
        poller = Poller.create('test', {});
    });

    afterEach(function() {
        this.sandbox.restore();
    });

    it('start', function() {
        this.sandbox.stub(poller, 'pollTaskRunnerLeases');
        expect(poller.running).to.equal(false);
        poller.start();
        expect(poller.running).to.equal(true);
        expect(poller.pollTaskRunnerLeases).to.have.been.calledOnce;
    });


    it('stop', function() {
        this.sandbox.stub(poller, 'pollTaskRunnerLeases');
        poller.start();
        poller.stop();
        expect(poller.running).to.equal(false);
    });

    it('isRunning', function() {
        poller.running = false;
        expect(poller.isRunning()).to.equal(false);
        poller.running = true;
        expect(poller.isRunning()).to.equal(true);
    });

    it('should publish if a graph is finished', function() {
        poller.publishGraphFinished({
            instanceId: 'testgraphid',
            _status: 'succeeded'
        });
        expect(eventsProtocol.publishGraphFinished).to.have.been.calledOnce;
        expect(eventsProtocol.publishGraphFinished).to.have.been.calledWith(
            'testgraphid', 'succeeded');
    });

    describe('processCompletedTasks', function() {
        it('should process a limited amount', function(done) {
            store.findCompletedTasks.resolves();

            poller.processCompletedTasks(100)
            .subscribe(
                function() {},
                done,
                subscribeWrapper(done, function() {
                    expect(store.findCompletedTasks).to.have.been.calledWith(100);
                })
            );
        });

        it('should only operate for completed tasks', function(done) {
            store.findCompletedTasks.resolves([]);
            this.sandbox.stub(poller, 'deleteCompletedGraphs');
            this.sandbox.stub(poller, 'deleteTasks');

            poller.processCompletedTasks()
            .subscribe(
                function() {},
                done,
                subscribeWrapper(done, function() {
                    expect(poller.deleteCompletedGraphs).to.not.have.been.called;
                    expect(poller.deleteTasks).to.not.have.been.called;
                })
            );
        });

        it('should handle stream errors', function(done) {
            this.sandbox.spy(poller, 'handleStreamError');
            var tasks = [
                { _id: 'id1', taskId: 'taskId1', graphId: 'graphId1' }
            ];
            store.deleteTasks.rejects(new Error('test'));

            poller.deleteTasks(tasks)
            .subscribe(
                function() {},
                done,
                subscribeWrapper(done, function() {
                    expect(poller.handleStreamError).to.have.been.calledOnce;
                    expect(poller.handleStreamError).to.have.been.calledWith(
                        'Error deleting completed tasks', new Error('test'));
                })
            );
        });
    });


    describe('deleteTasks', function() {
        it('should have an output that equals the input', function(done) {
            var tasks = [
                { _id: 'id1', taskId: 'taskId1', graphId: 'graphId1' },
                { _id: 'id2', taskId: 'taskId2', graphId: 'graphId2' },
                { _id: 'id3', taskId: 'taskId3', graphId: 'graphId3' }
            ];
            var expected = _(tasks).map('_id').value();

            poller.deleteTasks(tasks)
            .subscribe(subscribeWrapper(done, function() {
                expect(store.deleteTasks).to.have.been.calledOnce;
                expect(store.deleteTasks).to.have.been.calledWith(expected);
            }), done);
        });

        it('should handle stream errors', function(done) {
            this.sandbox.spy(poller, 'handleStreamError');
            var tasks = [
                { _id: 'id1', taskId: 'taskId1', graphId: 'graphId1' }
            ];
            store.deleteTasks.rejects(new Error('test'));

            poller.deleteTasks(tasks)
            .subscribe(
                function() {},
                done,
                subscribeWrapper(done, function() {
                    expect(poller.handleStreamError).to.have.been.calledOnce;
                    expect(poller.handleStreamError).to.have.been.calledWith(
                        'Error deleting completed tasks', new Error('test'));
                })
            );
        });
    });

    describe('deleteCompletedGraphs', function() {
        it('should take only graphIds from last tasks', function(done) {
            this.sandbox.stub(poller, 'handlePotentialFinishedGraph', function(data) {
                return Rx.Observable.just(data);
            });
            var tasks = [
                {
                    taskId: 'taskId1',
                    terminalOnStates: ['succeeded'],
                    state: 'succeeded',
                    graphId: 'graphId1'
                },
                {
                    taskId: 'taskId2',
                    terminalOnStates: ['failed'],
                    state: 'succeeded',
                    graphId: 'graphId2'
                },
                {
                    taskId: 'taskId2',
                    terminalOnStates: ['succeeded'],
                    state: 'succeeded',
                    graphId: 'graphId3'
                }
            ];

            poller.deleteCompletedGraphs(tasks)
            .subscribe(subscribeWrapper(done, function() {
                expect(poller.handlePotentialFinishedGraph).to.have.been.calledTwice;
                expect(poller.handlePotentialFinishedGraph).to.have.been.calledWith(tasks[0]);
                expect(poller.handlePotentialFinishedGraph).to.not.have.been.calledWith(tasks[1]);
                expect(poller.handlePotentialFinishedGraph).to.have.been.calledWith(tasks[2]);
            }), done);
        });

        it('should have an output that equals the input', function(done) {
            this.sandbox.stub(poller, 'handlePotentialFinishedGraph', function(data) {
                return Rx.Observable.just(data);
            });
            var tasks = [
                {
                    taskId: 'taskId1',
                    terminalOnStates: ['succeeded'],
                    state: 'succeeded',
                    graphId: 'graphId1'
                },
                {
                    taskId: 'taskId2',
                    terminalOnStates: ['failed'],
                    state: 'succeeded',
                    graphId: 'graphId2'
                }
            ];

            poller.deleteCompletedGraphs(tasks)
            .subscribe(subscribeWrapper(done, function(out) {
                expect(out).to.equal(tasks);
            }), done);
        });

        it('should handle stream errors', function(done) {
            this.sandbox.stub(poller, 'handlePotentialFinishedGraph').rejects(new Error('test'));
            this.sandbox.spy(poller, 'handleStreamError');
            var tasks = [
                { taskId: 'taskId', terminal: true, graphId: 'graphId' }
            ];

            poller.deleteCompletedGraphs(tasks)
            .subscribe(
                function() {},
                done,
                done,
                subscribeWrapper(done, function() {
                    expect(poller.handleStreamError).to.have.been.calledOnce;
                    expect(poller.handleStreamError).to.have.been.calledWith(
                        'Error handling potential finished graphs', new Error('test'));
                })
            );
        });
    });

    describe('handlePotentialFinishedGraph', function() {
        it('should set graph state to failed', function(done) {
            this.sandbox.stub(store, 'checkGraphFinished').resolves();

            var data = {
                state: Constants.TaskStates.Failed
            };

            poller.handlePotentialFinishedGraph(data)
            .subscribe(subscribeWrapper(done, function() {
                expect(store.setGraphDone).to.have.been.calledOnce;
                expect(store.setGraphDone).to.have.been.calledWith(
                    Constants.TaskStates.Failed,
                    {
                        failed: true,
                        done: true,
                        state: Constants.TaskStates.Failed
                    }
                );
            }), done);
        });

        it('should set graph state to succeeded', function(done) {
            this.sandbox.stub(store, 'checkGraphFinished', function(_data) {
                _data.done = true;
                return Promise.resolve(_data);
            });
            store.setGraphDone.resolves({
                instanceId: 'testgraphid',
                _status: Constants.TaskStates.Succeeded
            });

            var data = {
                state: Constants.TaskStates.Succeeded
            };

            poller.handlePotentialFinishedGraph(data)
            .subscribe(subscribeWrapper(done, function() {
                expect(store.checkGraphFinished).to.have.been.calledOnce;
                expect(store.checkGraphFinished).to.have.been.calledWith({
                    done: true,
                    state: Constants.TaskStates.Succeeded
                });
                expect(store.setGraphDone).to.have.been.calledOnce;
                expect(store.setGraphDone).to.have.been.calledWith(
                    Constants.TaskStates.Succeeded,
                    {
                        done: true,
                        state: Constants.TaskStates.Succeeded
                    }
                );
                expect(eventsProtocol.publishGraphFinished).to.have.been.calledOnce;
                expect(eventsProtocol.publishGraphFinished).to.have.been.calledWith(
                    'testgraphid',
                    Constants.TaskStates.Succeeded
                );
            }), done);
        });

        it('should do nothing if the graph is not finished', function(done) {
            this.sandbox.stub(store, 'checkGraphFinished').resolves({ done: false });

            poller.handlePotentialFinishedGraph({})
            .subscribe(subscribeWrapper(done, function() {
                expect(store.setGraphDone).to.not.have.been.called;
                expect(eventsProtocol.publishGraphFinished).to.not.have.been.called;
            }), done);
        });
    });
});
