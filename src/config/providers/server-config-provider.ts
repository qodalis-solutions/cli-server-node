import * as os from 'os';
import { formatCliConfigDuration, type CliConfigProviderStorage, type CliConfigSection, type ICliConfigProvider } from '@qodalis/cli-server-abstractions';

/**
 * `server` (read-only): the server process (today's admin `server` section): platform, Node.js
 * version, server version, `NODE_ENV`, process id, host name, start time and uptime.
 */
export class CliServerConfigProvider implements ICliConfigProvider {
    readonly id = 'server';
    readonly title = 'Server';
    readonly description = 'The server process (read-only)';
    readonly order = 0;
    readonly storage: CliConfigProviderStorage = { kind: 'runtime', description: 'Read from the running server process', sources: [] };
    private readonly startedAt = new Date();

    constructor(private readonly version: string) {}

    getSections(): CliConfigSection[] {
        const uptimeSeconds = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
        return [
            {
                id: 'runtime',
                title: 'Runtime',
                entries: [
                    { key: 'platform', label: 'Platform', description: 'Server platform', type: 'string', value: 'node' },
                    { key: 'platformVersion', label: 'Platform version', description: 'Node.js version', type: 'string', value: process.version },
                    { key: 'version', label: 'Server version', description: 'Version of @qodalis/cli-server-node', type: 'string', value: this.version },
                    {
                        key: 'nodeEnv',
                        label: 'Environment',
                        description: 'NODE_ENV',
                        type: 'string',
                        value: process.env.NODE_ENV ?? 'development',
                        source: process.env.NODE_ENV !== undefined ? 'environment' : 'default',
                    },
                    { key: 'pid', label: 'Process id', description: 'Process ID', type: 'number', value: process.pid },
                    { key: 'hostname', label: 'Host name', description: 'Name of the machine', type: 'string', value: os.hostname() },
                    { key: 'os', label: 'Operating system', description: 'OS platform and architecture', type: 'string', value: `${process.platform} ${process.arch}` },
                    { key: 'startedAt', label: 'Started at', description: 'When the server started (UTC)', type: 'string', value: this.startedAt.toISOString() },
                    { key: 'uptime', label: 'Uptime', description: 'Time since the server started', type: 'duration', value: formatCliConfigDuration(uptimeSeconds * 1000) },
                ],
            },
        ];
    }
}
