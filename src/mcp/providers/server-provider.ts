import * as os from 'os';
import { ICliCommandRegistry } from '../../services/cli-command-registry';
import { McpTool, McpToolProvider, mcpJson, mcpObjectSchema } from '../mcp-types';

export interface ServerInfoSource {
    registry: ICliCommandRegistry;
    serverName: string;
    version: string;
    /** Live capabilities (shell state, …). */
    capabilities: () => Record<string, unknown>;
    /** Live list of enabled features. */
    features: () => string[];
}

/** `server_info`: version, capabilities, enabled features and registered command names. */
export class ServerMcpToolProvider implements McpToolProvider {
    readonly name = 'server';

    constructor(private readonly source: ServerInfoSource) {}

    getTools(): McpTool[] {
        return [
            {
                name: 'server_info',
                description: 'Server version, capabilities, enabled features and registered command names',
                inputSchema: mcpObjectSchema(),
                requiredPermissions: [],
                annotations: { readOnlyHint: true },
                call: async () => {
                    const platform = os.platform();
                    return mcpJson({
                        name: this.source.serverName,
                        version: this.source.version,
                        capabilities: {
                            os: platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux',
                            streaming: true,
                            ...this.source.capabilities(),
                        },
                        features: this.source.features(),
                        commands: this.source.registry.processors.map((p) => p.command),
                    });
                },
            },
        ];
    }
}
