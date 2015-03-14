module.exports = {
    friendlyName: 'SKU Discovery',
    injectableName: 'Graph.SKU.Discovery',
    options: {
        defaults: {
            graphOptions: {
                target: null
            },
            nodeId: null
        }
    },
    tasks: [
        {
            label: 'discovery-graph',
            taskDefinition: {
                friendlyName: 'Run Discovery Graph',
                injectableName: 'Task.Graph.Run.Discovery',
                implementsTask: 'Task.Base.Graph.Run',
                options: {
                    graphName: 'Graph.Discovery',
                    graphOptions: {}
                },
                properties: {}
            },
        },
        {
            label: 'generate-sku',
            waitOn: {
                'discovery-graph': 'succeeded'
            },
            taskName: 'Task.Catalog.GenerateSku'
        },
        {
            label: 'create-default-pollers',
            taskDefinition: {
                friendlyName: 'Create Default Pollers',
                injectableName: 'Task.Inline.Pollers.CreateDefault',
                implementsTask: 'Task.Base.Pollers.CreateDefault',
                options: {
                    nodeId: null
                },
                properties: {}
            },
            waitOn: {
                'discovery-graph': 'succeeded'
            }
        },
        {
            label: 'run-sku-graph',
            taskDefinition: {
                friendlyName: 'Run SKU-specific graph',
                injectableName: 'Task.Graph.Run.SkuSpecific',
                implementsTask: 'Task.Base.Graph.RunSku',
                options: {},
                properties: {}
            },
            waitOn: {
                'generate-sku': 'succeeded'
            }

        }
    ]
};