'use strict';
// A server plugin as a package installed from the marketplace: CommonJS, the abstractions from the server.
const abstractions = require('@qodalis/cli-server-abstractions');
const { greet } = require('./greeting');

exports.abstractionsPath = require.resolve('@qodalis/cli-server-abstractions');
exports.abstractionsIsHost = typeof abstractions.CliStoredConfigProvider === 'function' && !abstractions.DECOY;

exports.createPlugin = async (context) => {
    const settings = await context.settings({
        title: 'Hello',
        settings: [
            { key: 'greeting', label: 'Greeting', type: 'string', default: 'Hello' },
            { key: 'times', type: 'number', default: 1, validation: { min: 1, max: 5 } },
        ],
    });
    const value = (key) => settings.value('settings', key);
    exports.lastContext = context;
    return {
        prefix: '/api/v1/qcli/hello',
        router: (req, res, next) => (req.path === '/' ? res.json({ greeting: value('greeting'), dataDir: context.dataDir }) : next()),
        module: {
            name: 'hello',
            version: context.version,
            description: 'Says hello',
            author: { name: 'Acme' },
            processors: [
                {
                    command: 'hello',
                    description: 'Says hello',
                    handleAsync: async (command) => greet(value('greeting'), command.value || 'world', value('times')),
                },
            ],
        },
    };
};
