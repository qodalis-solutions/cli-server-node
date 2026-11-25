import {
    CliConfigPermissions,
    cliConfigContext,
    isCliConfigError,
    type CliConfigContext,
    type CliConfigValue,
    type ICliConfigService,
} from '@qodalis/cli-server-abstractions';
import type { CliServerAuthContext, ICliServerAuth } from '../../auth/cli-server-auth';
import { McpTool, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

/**
 * `config_list`, `config_get` (read-only, `config:read`) and `config_set` (`config:write`, not
 * read-only: hidden by the endpoint's `readOnly` option and the MCP client's `QCLI_READ_ONLY`).
 * Secrets are never returned.
 */
export class ConfigMcpToolProvider implements McpToolProvider {
    readonly name = 'config';

    constructor(
        private readonly service: ICliConfigService,
        private readonly getAuth: () => ICliServerAuth | undefined,
    ) {}

    private context(auth: CliServerAuthContext | undefined): CliConfigContext {
        const server = this.getAuth();
        if (!server?.protectServer || !auth) return cliConfigContext(undefined, 'mcp');
        return {
            caller: { userId: auth.userId, userName: auth.userName, permissions: auth.permissions },
            hasPermission: (p) => server.hasPermission(auth, p),
            via: 'mcp',
        };
    }

    private async run(fn: () => Promise<McpToolResultLike>): Promise<McpToolResultLike> {
        try {
            return await fn();
        } catch (err) {
            if (isCliConfigError(err)) {
                const body = err.toJSON();
                return { text: JSON.stringify(body, null, 2), structured: body as Record<string, unknown>, isError: true };
            }
            throw err;
        }
    }

    getTools(): McpTool[] {
        return [
            {
                name: 'config_list',
                description: "The server's config providers (where each reads its settings from, and the store a stored one saves changes to), the default store, and their sections (ids, titles, whether writable, versions); read a section with config_get",
                inputSchema: mcpObjectSchema(),
                requiredPermissions: [CliConfigPermissions.Read],
                annotations: { readOnlyHint: true },
                call: (_args, ctx) =>
                    this.run(async () => {
                        const providers = await this.service.list(this.context(ctx.auth));
                        return mcpJson({
                            defaultStore: this.service.describeDefaultStore(),
                            providers: providers.map((p) => ({
                                id: p.id,
                                title: p.title,
                                description: p.description,
                                writable: p.writable,
                                storage: p.storage,
                                ...(p.store ? { store: p.store } : {}),
                                sections: p.sections.map((s) => ({ id: s.id, title: s.title, mutable: s.mutable, version: s.version, keys: s.entries.length })),
                            })),
                        });
                    }),
            },
            {
                name: 'config_get',
                description: 'A config provider, one of its sections, or one setting (provider, section, key): values, defaults, sources and validation rules; secrets show only isSet',
                inputSchema: mcpObjectSchema(
                    {
                        provider: { type: 'string', description: 'Provider id (config_list)' },
                        section: { type: 'string', description: 'Section id (optional)' },
                        key: { type: 'string', description: 'Setting key (optional, with section)' },
                    },
                    ['provider'],
                ),
                requiredPermissions: [CliConfigPermissions.Read],
                annotations: { readOnlyHint: true },
                call: (args, ctx) =>
                    this.run(async () => {
                        const provider = await this.service.get(String(args.provider), this.context(ctx.auth));
                        if (args.section === undefined || args.section === null) return mcpJson({ provider });
                        const section = provider.sections.find((s) => s.id === args.section);
                        if (!section) return mcpError(`unknown config section: ${provider.id}.${String(args.section)}`);
                        if (args.key === undefined || args.key === null) return mcpJson({ provider: provider.id, section });
                        const entry = section.entries.find((e) => e.key === args.key);
                        if (!entry) return mcpError(`unknown setting: ${provider.id}.${section.id}.${String(args.key)}`);
                        return mcpJson({ provider: provider.id, section: section.id, version: section.version, entry });
                    }),
            },
            {
                name: 'config_set',
                description:
                    'Changes settings of a config section: changes maps keys to new values (null resets to the default, clears a secret); pass the version from config_get to refuse a stale change. Answers per-key errors when invalid',
                inputSchema: mcpObjectSchema(
                    {
                        provider: { type: 'string', description: 'Provider id' },
                        section: { type: 'string', description: 'Section id' },
                        changes: { type: 'object', description: 'Key to new value (null resets)' },
                        version: { type: 'string', description: 'The section version the change is based on (optional)' },
                    },
                    ['provider', 'section', 'changes'],
                ),
                requiredPermissions: [CliConfigPermissions.Write],
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
                call: (args, ctx) =>
                    this.run(async () => {
                        const result = await this.service.update(
                            String(args.provider),
                            String(args.section),
                            {
                                changes: args.changes as Record<string, CliConfigValue>,
                                ...(typeof args.version === 'string' ? { version: args.version } : {}),
                            },
                            this.context(ctx.auth),
                        );
                        return mcpJson({ ...result });
                    }),
            },
        ];
    }
}

type McpToolResultLike = Awaited<ReturnType<McpTool['call']>>;
