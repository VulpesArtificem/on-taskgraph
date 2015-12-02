// Copyright 2015, EMC, Inc.
/* jshint: node:true */

'use strict';

var di = require('di'),
    _ = require('lodash'),
    core = require('on-core')(di),
    tasks = require('on-tasks'),
    injector = new di.Injector(
        _.flatten([
            core.injectables,
            tasks.injectables,
            require('./lib/task-graph'),
            require('./lib/task-graph-runner'),
            require('./lib/task-runner.js'),
            require('./lib/messenger.js'),
            require('./lib/messengers/messenger-AMQP.js'),
            require('./lib/messengers/messenger-mongo.js'),
            require('./lib/task-graph-subscriptions'),
            require('./lib/store'),
            require('./lib/task-scheduler'),
            require('./lib/loader'),
            require('./lib/scheduler'),
            require('./lib/registry'),
            require('./lib/service-graph'),
            require('./lib/stores/memory'),
            require('./lib/stores/waterline'),
            require('./lib/stores/mongo')
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
    logger.error('Task Graph Runner Startup Error.', { error: error });
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
