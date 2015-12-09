// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di'),
    _ = require('lodash'),
    core = require('on-core')(di),
    injector = new di.Injector(
        _.flatten([
            core.injectables,
            core.workflowInjectables,
            require('on-tasks').injectables,
            require('./lib/task-graph-runner.js'),
            require('./lib/task-runner.js'),
            require('./lib/task-graph-subscriptions.js'),
            require('./lib/task-scheduler.js'),
            require('./lib/lease-expiration-poller.js'),
            require('./lib/loader.js'),
            require('./lib/service-graph.js'),
            require('./lib/rx-mixins.js')
        ])
    ),
    taskGraphRunner = injector.get('TaskGraph.Runner'),
    logger = injector.get('Logger').initialize('TaskGraph');

var options = {
    runner: true,
    scheduler: true
};

if (_.contains(process.argv, '-s') || _.contains(process.argv, '--scheduler')) {
    options.runner = false;
} else if (_.contains(process.argv, '-r') || _.contains(process.argv, '--runner')) {
    options.scheduler = false;
}

taskGraphRunner.start(options)
.then(function() {
    logger.info('Task Graph Runner Started.');
})
.catch(function(error) {
    logger.error('Task Graph Runner Startup Error.', {
        // stacks on some error objects (particularly from the assert library)
        // don't get printed if part of the error object so separate them out here.
        error: _.omit(error, 'stack'),
        stack: error.stack
    });
    process.nextTick(function() {
        process.exit(1);
    });
});

process.on('SIGINT', function() {
    taskGraphRunner.stop()
    .catch(function(error) {
        logger.error('Task Graph Runner Shutdown Error.', { error: error });
    })
    .finally(function() {
        process.nextTick(function() {
            process.exit(1);
        });
    });
});
