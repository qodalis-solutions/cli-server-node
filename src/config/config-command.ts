import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliConfigPermissions,
    CliProcessCommand,
    cliConfigContext,
    describeCliConfigStoreLine,
    describeCliConfigStoreName,
    getCliCaller,
    getPositionals,
    isCliConfigError,
    parseCliConfigInput,
    type CliConfigEntryView,
    type CliConfigProviderView,
    type CliConfigSectionView,
    type CliConfigValue,
    type ICliCommandProcessor,
    type ICliConfigService,
} from '@qodalis/cli-server-abstractions';

/**
 * `--expected-version`: the section version a change is based on. Not `--version`: the web CLI answers that global
 * flag itself (it prints the command's version), so it would never reach the server; raw API callers may still send it.
 */
const expectedVersionParam = new CliCommandParameterDescriptor('expected-version', 'The section version the change is based on (refused when stale)', false, 'string');

function expectedVersionOf(command: CliProcessCommand): string | undefined {
    const value = command.args?.['expected-version'] ?? command.args?.version;
    return value !== undefined && value !== null && value !== true ? String(value) : undefined;
}

/** The caller of the command (protected servers), as a config context. */
function contextOf() {
    const caller = getCliCaller();
    return cliConfigContext(caller ? { userId: caller.userId, userName: caller.userName, permissions: caller.permissions } : undefined, 'terminal');
}

/** A value as printed: strings as they are, anything else as JSON; secrets as set / not set. */
export function formatConfigValue(entry: Pick<CliConfigEntryView, 'value' | 'sensitive' | 'isSet'>): string {
    if (entry.sensitive) return entry.isSet ? '(set)' : '(not set)';
    if (entry.value === null || entry.value === undefined) return '(none)';
    return typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
}

function errorText(err: unknown): string {
    if (isCliConfigError(err)) {
        const lines = [`Error: ${err.message}${err.version !== undefined ? ` (current version ${err.version})` : ''}`];
        for (const [key, message] of Object.entries(err.errors ?? {})) lines.push(`  ${key}: ${message}`);
        return lines.join('\n');
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

interface ConfigPath {
    provider: CliConfigProviderView;
    section?: CliConfigSectionView;
    /** The rest after the section: the key (may contain dots). */
    key?: string;
}

/**
 * Resolves `provider[.section[.key]]`: the provider id has no dots; the section is the longest
 * section id the rest starts with (ids and keys may contain dots).
 */
async function resolvePath(service: ICliConfigService, path: string): Promise<ConfigPath> {
    const [providerId, ...restParts] = path.split('.');
    const provider = await service.get(providerId, contextOf());
    const rest = restParts.join('.');
    if (!rest) return { provider };
    const section = provider.sections
        .filter((s) => rest === s.id || rest.startsWith(`${s.id}.`))
        .sort((a, b) => b.id.length - a.id.length)[0];
    if (!section) throw new Error(`unknown config section: ${providerId}.${rest}`);
    const key = rest.length > section.id.length ? rest.slice(section.id.length + 1) : undefined;
    return { provider, section, ...(key ? { key } : {}) };
}

function describeSection(provider: string, section: CliConfigSectionView): string[] {
    const lines = [`${provider}.${section.id}${section.title !== section.id ? `  ${section.title}` : ''}${section.version !== null ? `  (version ${section.version})` : '  (read-only)'}`];
    const width = Math.min(32, Math.max(0, ...section.entries.map((e) => e.key.length)));
    for (const e of section.entries) {
        const flags = [e.type, e.source, ...(e.mutable ? [] : ['read-only']), ...(e.requiresRestart ? ['restart'] : [])].join(', ');
        lines.push(`  ${e.key.padEnd(width)}  ${formatConfigValue(e)}  [${flags}]`);
    }
    if (section.entries.length === 0) lines.push('  (no settings)');
    return lines;
}

function describeEntry(provider: string, section: CliConfigSectionView, e: CliConfigEntryView): string {
    const lines = [
        `${provider}.${section.id}.${e.key}`,
        `  Label         ${e.label}`,
        ...(e.description ? [`  Description   ${e.description}`] : []),
        `  Type          ${e.type}`,
        `  Value         ${formatConfigValue(e)}`,
        ...(e.sensitive ? [] : [`  Default       ${formatConfigValue({ value: e.default, sensitive: false })}`]),
        `  Source        ${e.source}`,
        `  Origin        ${e.origin ?? 'default'}`,
        `  Mutable       ${e.mutable ? 'yes' : 'no'}${e.requiresRestart ? ' (restart required)' : ''}`,
    ];
    const v = e.validation;
    if (v) {
        const rules = [
            v.required ? 'required' : '',
            v.min !== undefined ? `min ${v.min}` : '',
            v.max !== undefined ? `max ${v.max}` : '',
            v.pattern !== undefined ? `pattern ${v.pattern}` : '',
            v.options?.length ? `one of ${v.options.join(', ')}` : '',
        ].filter(Boolean);
        if (rules.length) lines.push(`  Validation    ${rules.join('; ')}`);
    }
    if (section.version !== null) lines.push(`  Version       ${section.version}`);
    return lines.join('\n');
}

class ConfigListProcessor extends CliCommandProcessor {
    command = 'list';
    description = 'Lists the config providers, the store each saves changes to, and their sections';
    requiredPermissions = [CliConfigPermissions.Read];

    constructor(private readonly service: ICliConfigService) {
        super();
    }

    async handleAsync(): Promise<string> {
        try {
            const providers = await this.service.list(contextOf());
            const lines: string[] = [`Default store: ${describeCliConfigStoreLine(this.service.describeDefaultStore())}`];
            if (providers.length === 0) return [...lines, 'No config providers.'].join('\n');
            for (const p of providers) {
                const from = p.storage?.sources?.length ? `from ${p.storage.sources.join(', ')}` : '';
                const notes = [p.writable ? '' : 'read-only', from].filter(Boolean).join('; ');
                const store = p.store ? `  · ${describeCliConfigStoreName(p.store)}` : '';
                lines.push(`${p.id}  ${p.title}${notes ? `  (${notes})` : ''}${store}`);
                for (const s of p.sections) {
                    lines.push(`  ${s.id.padEnd(16)} ${String(s.entries.length).padStart(3)} setting(s)${s.version !== null ? `  version ${s.version}` : ''}`);
                }
            }
            return lines.join('\n');
        } catch (err) {
            return errorText(err);
        }
    }
}

class ConfigGetProcessor extends CliCommandProcessor {
    command = 'get';
    description = 'Shows a provider, a section or one setting: config get <provider>[.<section>[.<key>]]';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [CliConfigPermissions.Read];
    examples = [
        { command: 'config get cors', description: 'Every section of the cors provider' },
        { command: 'config get cors.cors.allowedOrigins', description: 'One setting with its default, source and rules' },
    ];

    constructor(private readonly service: ICliConfigService) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const [path] = getPositionals(command);
            if (!path) return 'Error: usage: config get <provider>[.<section>[.<key>]]';
            const { provider, section, key } = await resolvePath(this.service, path);
            if (!section) {
                const lines = [`${provider.id}  ${provider.title}${provider.description ? `  ${provider.description}` : ''}`];
                for (const s of provider.sections) lines.push(...describeSection(provider.id, s));
                return lines.join('\n');
            }
            if (!key) return describeSection(provider.id, section).join('\n');
            const entry = section.entries.find((e) => e.key === key);
            if (!entry) return `Error: unknown setting: ${provider.id}.${section.id}.${key}`;
            return describeEntry(provider.id, section, entry);
        } catch (err) {
            return errorText(err);
        }
    }
}

class ConfigSetProcessor extends CliCommandProcessor {
    command = 'set';
    description = 'Changes a setting: config set <provider>.<section>.<key> <value> [--expected-version v]';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [CliConfigPermissions.Write];
    parameters = [expectedVersionParam];
    examples = [
        { command: 'config set cors.cors.allowedOrigins https://app.example.com,http://localhost:*', description: 'A list: comma-separated or a JSON array' },
        { command: 'config set mcp.mcp.readOnly true --expected-version 3', description: 'Refused when the section changed since version 3' },
        { command: 'config set custom.custom.motd "Hello there"', description: 'A free key of the custom provider' },
    ];

    constructor(private readonly service: ICliConfigService) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const [path, ...words] = getPositionals(command);
            if (!path || words.length === 0) return 'Error: usage: config set <provider>.<section>.<key> <value> [--expected-version v]';
            const { provider, section, key } = await resolvePath(this.service, path);
            if (!section || !key) return 'Error: name a setting: <provider>.<section>.<key>';
            const text = words.join(' ');
            const entry = section.entries.find((e) => e.key === key);
            let value: CliConfigValue;
            try {
                if (entry) {
                    value = parseCliConfigInput(entry.type, text);
                } else {
                    // A new key of a free section: JSON when it parses (numbers, booleans, lists), else the text
                    try {
                        value = JSON.parse(text) as CliConfigValue;
                    } catch {
                        value = text;
                    }
                }
            } catch (err) {
                return `Error: validation failed\n  ${key}: ${(err as Error).message}`;
            }
            const version = expectedVersionOf(command);
            const result = await this.service.update(provider.id, section.id, { changes: { [key]: value }, ...(version ? { version } : {}) }, contextOf());
            const updated = result.section.entries.find((e) => e.key === key);
            const shown = updated ? formatConfigValue(updated) : '';
            return [
                `Updated ${provider.id}.${section.id}.${key}${shown ? ` = ${shown}` : ''} (version ${result.version})`,
                ...(result.requiresRestart ? ['Restart the server for the change to take effect.'] : []),
            ].join('\n');
        } catch (err) {
            return errorText(err);
        }
    }
}

class ConfigResetProcessor extends CliCommandProcessor {
    command = 'reset';
    description = 'Resets a setting to its default (clears a secret, removes a free key): config reset <provider>.<section>.<key>';
    acceptsValue = true;
    valueRequired = true;
    requiredPermissions = [CliConfigPermissions.Write];
    parameters = [expectedVersionParam];
    examples = [{ command: 'config reset cors.cors.allowedOrigins', description: 'Back to the origins the server was started with' }];

    constructor(private readonly service: ICliConfigService) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        try {
            const [path] = getPositionals(command);
            if (!path) return 'Error: usage: config reset <provider>.<section>.<key>';
            const { provider, section, key } = await resolvePath(this.service, path);
            if (!section || !key) return 'Error: name a setting: <provider>.<section>.<key>';
            const version = expectedVersionOf(command);
            const result = await this.service.update(provider.id, section.id, { changes: { [key]: null }, ...(version ? { version } : {}) }, contextOf());
            const updated = result.section.entries.find((e) => e.key === key);
            return [
                `Reset ${provider.id}.${section.id}.${key}${updated ? ` = ${formatConfigValue(updated)}` : ''} (version ${result.version})`,
                ...(result.requiresRestart ? ['Restart the server for the change to take effect.'] : []),
            ].join('\n');
        } catch (err) {
            return errorText(err);
        }
    }
}

/**
 * `config`: the server's configuration from the terminal. `list`, `get <provider>[.<section>[.<key>]]`,
 * `set <provider>.<section>.<key> <value> [--expected-version v]`, `reset <provider>.<section>.<key>`.
 * `config:read` for the command, `config:write` for set and reset; secrets are accepted, never printed.
 */
export class CliConfigCommandProcessor extends CliCommandProcessor {
    command = 'config';
    description = "The server's configuration: list providers, show, change and reset settings";
    module = 'config';
    icon = '⚙️';
    requiredPermissions = [CliConfigPermissions.Read];
    processors: ICliCommandProcessor[];
    private readonly list: ConfigListProcessor;

    constructor(service: ICliConfigService) {
        super();
        this.list = new ConfigListProcessor(service);
        this.processors = [this.list, new ConfigGetProcessor(service), new ConfigSetProcessor(service), new ConfigResetProcessor(service)];
    }

    handleAsync(): Promise<string> {
        return this.list.handleAsync();
    }
}
