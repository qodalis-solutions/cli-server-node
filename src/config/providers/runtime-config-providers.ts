import { CliStoredConfigProvider, type CliConfigValue } from '@qodalis/cli-server-abstractions';
import type { CliMcpOptions } from '../../mcp/mcp-controller';
import type { FileSystemApiOptions } from '../../filesystem/filesystem-options';

/** An origin: `http(s)://host[:port]` or `http(s)://host:*` (any port), no path. */
const ORIGIN = /^https?:\/\/[^\s/:?#]+(:(\d{1,5}|\*))?$/i;

/** The first invalid origin of a list, as an error message. */
export function invalidOrigin(value: CliConfigValue): string | undefined {
    const bad = (value as string[]).find((o) => !ORIGIN.test(o.trim().replace(/\/+$/, '')));
    return bad !== undefined ? `'${bad}' is not an origin (http(s)://host[:port], or :* for any port)` : undefined;
}

/** How CORS headers are decided (`createCliServer`'s `cors` option). */
export type CliCorsMode = 'origins' | 'permissive' | 'custom' | 'disabled';

/**
 * `cors`: the allowed origins, changeable at runtime. `origins` is the server's live list (CORS
 * in `origins` mode, WebSocket upgrades, the MCP endpoint, the users plugin's CSRF check):
 * changes replace its items in place.
 */
export function createCorsConfigProvider(origins: string[], mode: CliCorsMode): CliStoredConfigProvider {
    const initial = [...origins];
    return new CliStoredConfigProvider({
        id: 'cors',
        title: 'CORS',
        description: 'Origins allowed to call the server from a browser and to open its WebSockets',
        order: 30,
        sections: [
            {
                id: 'cors',
                title: 'CORS',
                settings: [
                    {
                        key: 'mode',
                        label: 'Mode',
                        description:
                            'origins: CORS headers for the allowed origins (and same-origin); permissive: any origin; custom: the host\'s cors options; disabled: none',
                        type: 'enum',
                        mutable: false,
                        default: mode,
                        validation: { options: ['origins', 'permissive', 'custom', 'disabled'] },
                    },
                    {
                        key: 'allowedOrigins',
                        label: 'Allowed origins',
                        description:
                            'Exact origins (http://host:port; http://host:* for any port). Used for CORS in origins mode, WebSocket upgrades, the MCP endpoint and CSRF checks',
                        type: 'string[]',
                        default: initial,
                        editor: 'origins',
                        validate: invalidOrigin,
                        apply: (value) => {
                            const next = (Array.isArray(value) ? (value as string[]) : initial).map((o) => o.trim());
                            origins.splice(0, origins.length, ...next);
                        },
                    },
                ],
            },
        ],
    });
}

/**
 * `mcp`: the MCP endpoint's tool lists, instructions and read-only mode, changeable at runtime
 * (`options` is the endpoint's live options object). Read-only when MCP is off.
 */
export function createMcpConfigProvider(options: CliMcpOptions | undefined, path: string): CliStoredConfigProvider {
    const enabled = !!options;
    const live = options ?? {};
    const initial = { tools: live.tools ? [...live.tools] : [], exclude: live.exclude ? [...live.exclude] : [], instructions: live.instructions ?? '', readOnly: live.readOnly === true };
    const list = (value: CliConfigValue): string[] | undefined => {
        const items = (value as string[] | null) ?? [];
        return items.length > 0 ? [...items] : undefined;
    };
    return new CliStoredConfigProvider({
        id: 'mcp',
        title: 'MCP',
        description: 'The MCP endpoint: which tools AI clients see',
        order: 40,
        sections: [
            {
                id: 'mcp',
                title: 'MCP endpoint',
                settings: [
                    { key: 'enabled', label: 'Enabled', description: 'The MCP endpoint is served (createCliServer({ mcp }))', type: 'boolean', mutable: false, requiresRestart: true, default: enabled },
                    { key: 'path', label: 'Path', description: 'Where the endpoint is served', type: 'string', mutable: false, default: path },
                    {
                        key: 'tools',
                        label: 'Allowed tools',
                        description: 'Allow-list of tool names (a trailing * matches a prefix); empty: every tool',
                        type: 'string[]',
                        default: initial.tools,
                        editor: 'tags',
                        mutable: enabled,
                        validation: { pattern: '^[a-z0-9_*-]{1,64}$' },
                        apply: (value) => {
                            live.tools = list(value);
                        },
                    },
                    {
                        key: 'exclude',
                        label: 'Excluded tools',
                        description: 'Deny-list of tool names, applied after the allow-list',
                        type: 'string[]',
                        default: initial.exclude,
                        editor: 'tags',
                        mutable: enabled,
                        validation: { pattern: '^[a-z0-9_*-]{1,64}$' },
                        apply: (value) => {
                            live.exclude = list(value);
                        },
                    },
                    {
                        key: 'instructions',
                        label: 'Instructions',
                        description: 'Returned to clients by initialize',
                        type: 'string',
                        default: initial.instructions,
                        editor: 'textarea',
                        mutable: enabled,
                        validation: { max: 4000 },
                        apply: (value) => {
                            live.instructions = typeof value === 'string' && value ? value : undefined;
                        },
                    },
                    {
                        key: 'readOnly',
                        label: 'Read-only',
                        description: 'Only tools annotated read-only (readOnlyHint) are listed and callable',
                        type: 'boolean',
                        default: initial.readOnly,
                        mutable: enabled,
                        apply: (value) => {
                            live.readOnly = value === true;
                        },
                    },
                ],
            },
        ],
    });
}

/**
 * `filesystem`: the filesystem API. The upload limit changes at runtime (`api` is the API's
 * live options object); the storage and the allowed roots are read-only on purpose: widening
 * what the server may read is a deployment decision, not a form field.
 */
export function createFilesystemConfigProvider(storage: string, api: FileSystemApiOptions, roots: string[] | undefined): CliStoredConfigProvider {
    const initialLimit = api.maxUploadBytes ?? 100 * 1024 * 1024;
    return new CliStoredConfigProvider({
        id: 'filesystem',
        title: 'Filesystem',
        description: 'The filesystem API (/api/qcli/fs)',
        order: 50,
        sections: [
            {
                id: 'filesystem',
                title: 'Filesystem',
                settings: [
                    { key: 'storage', label: 'Storage', description: 'The storage provider', type: 'string', mutable: false, default: storage },
                    {
                        key: 'allowedPaths',
                        label: 'Allowed roots',
                        description: 'Directories the API may access (OS storage); set in code',
                        type: 'string[]',
                        mutable: false,
                        requiresRestart: true,
                        default: roots ? [...roots] : [],
                    },
                    {
                        key: 'maxUploadBytes',
                        label: 'Upload limit',
                        description: 'Largest file accepted by POST /upload, in bytes',
                        type: 'number',
                        default: initialLimit,
                        validation: { min: 1, max: 10 * 1024 * 1024 * 1024 },
                        validate: (value) => (Number.isInteger(value) ? undefined : 'must be a whole number of bytes'),
                        apply: (value) => {
                            api.maxUploadBytes = typeof value === 'number' ? value : initialLimit;
                        },
                    },
                ],
            },
        ],
    });
}
