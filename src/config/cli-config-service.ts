import {
    CLI_CONFIG_AUDIT_EVENT,
    CLI_CONFIG_CHANGED_EVENT,
    CLI_CONFIG_KEY,
    CLI_CONFIG_SECRET_MASK,
    CliConfigConflictError,
    CliConfigError,
    CliConfigPermissions,
    CliConfigValidationError,
    cloneCliConfigValue,
    isCliConfigWriter,
    validateCliConfigValue,
    type AuditEntry,
    type CliConfigContext,
    type CliConfigEntry,
    type CliConfigEntryView,
    type CliConfigErrors,
    type CliConfigProviderView,
    type CliConfigSection,
    type CliConfigSectionView,
    type CliConfigUpdateRequest,
    type CliConfigUpdateResponse,
    type CliConfigValue,
    type ICliConfigProvider,
    type ICliConfigService,
    type ICliEventBus,
} from '@qodalis/cli-server-abstractions';
import { CliConfigRegistry, DEFAULT_CONFIG_PROVIDER_ORDER } from './cli-config-registry';
import { createLogger } from '../utils/logger';

const logger = createLogger('Config');

/** Where config changes are audited (`config.update`). */
export type CliConfigAuditSink = (entry: AuditEntry) => Promise<void>;

export interface CliConfigServiceOptions {
    /** The audit sink, read on every change (the auth provider may be installed later). */
    audit?: () => CliConfigAuditSink | undefined;
    /** The event bus `config:changed` is published on, read on every change. */
    eventBus?: () => ICliEventBus | undefined;
}

/** One change of an audit entry: secrets as `***` (or null when unset). */
export interface CliConfigAuditChange {
    key: string;
    old: CliConfigValue;
    new: CliConfigValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** An entry as the API returns it: defaults filled, the value of a sensitive entry never included. */
export function toCliConfigEntryView(entry: CliConfigEntry, writable: boolean): CliConfigEntryView {
    const sensitive = entry.sensitive === true || entry.type === 'secret';
    const value = entry.value ?? null;
    return {
        key: entry.key,
        label: entry.label ?? entry.key,
        description: entry.description ?? '',
        type: entry.type,
        value: sensitive ? null : cloneCliConfigValue(value),
        default: sensitive ? null : cloneCliConfigValue(entry.default ?? null),
        source: entry.source ?? 'default',
        mutable: writable && entry.mutable === true,
        requiresRestart: entry.requiresRestart === true,
        sensitive,
        ...(sensitive ? { isSet: entry.isSet ?? (value !== null && value !== '' && !(Array.isArray(value) && value.length === 0)) } : {}),
        ...(entry.validation ? { validation: { ...entry.validation, ...(entry.validation.options ? { options: [...entry.validation.options] } : {}) } } : {}),
        ...(entry.editor ? { editor: entry.editor } : {}),
    };
}

/** A section as the API returns it; `writable`: the provider implements the writer. */
export function toCliConfigSectionView(section: CliConfigSection, writable: boolean): CliConfigSectionView {
    const entries = (section.entries ?? []).map((e) => toCliConfigEntryView(e, writable));
    const allowCustomKeys = writable && section.allowCustomKeys === true;
    const mutable = allowCustomKeys || entries.some((e) => e.mutable);
    return {
        id: section.id,
        title: section.title ?? section.id,
        description: section.description ?? '',
        mutable,
        version: mutable ? (section.version ?? null) : null,
        allowCustomKeys,
        entries,
    };
}

/** How a value appears in the audit log: a secret as `***`, or null when cleared/unset. */
function auditValue(view: CliConfigEntryView | undefined, raw: CliConfigValue | undefined, side: 'old' | 'new'): CliConfigValue {
    if (view?.sensitive) {
        if (side === 'old') return view.isSet ? CLI_CONFIG_SECRET_MASK : null;
        return raw === null || raw === undefined || raw === '' ? null : CLI_CONFIG_SECRET_MASK;
    }
    return cloneCliConfigValue((side === 'old' ? view?.value : (view?.value ?? raw)) ?? null);
}

/**
 * The server's config providers, read and changed with permissions, validation, conflicts,
 * secrets masked, audit (`config.update`) and events (`config:changed`): the HTTP API (admin
 * plugin), the `config` command and the MCP tools all go through it.
 */
export class CliConfigService implements ICliConfigService {
    constructor(
        readonly registry: CliConfigRegistry,
        private readonly options: CliConfigServiceOptions = {},
    ) {}

    /** Resolves once every provider has applied its stored settings (`createCliServer` starts loading them). */
    ready(): Promise<void> {
        return this.registry.ready();
    }

    private requirePermission(context: CliConfigContext, permission: string): void {
        if (!context.hasPermission(permission)) {
            throw new CliConfigError(403, `forbidden: missing permission ${permission}`);
        }
    }

    private canSee(provider: ICliConfigProvider, context: CliConfigContext): boolean {
        return !provider.requiredPermission || context.hasPermission(provider.requiredPermission);
    }

    private provider(providerId: string, context: CliConfigContext): ICliConfigProvider {
        const provider = typeof providerId === 'string' ? this.registry.find(providerId) : undefined;
        if (!provider) throw new CliConfigError(404, `unknown config provider: ${providerId}`);
        if (!this.canSee(provider, context)) {
            throw new CliConfigError(403, `forbidden: missing permission ${provider.requiredPermission}`);
        }
        return provider;
    }

    private async view(provider: ICliConfigProvider, context: CliConfigContext): Promise<CliConfigProviderView> {
        const writer = isCliConfigWriter(provider);
        const sections = await provider.getSections(context);
        return {
            id: provider.id,
            title: provider.title,
            description: provider.description ?? '',
            order: provider.order ?? DEFAULT_CONFIG_PROVIDER_ORDER,
            writable: writer && context.hasPermission(CliConfigPermissions.Write),
            sections: (sections ?? []).map((s) => toCliConfigSectionView(s, writer)),
        };
    }

    async list(context: CliConfigContext): Promise<CliConfigProviderView[]> {
        this.requirePermission(context, CliConfigPermissions.Read);
        await this.ready();
        const views: CliConfigProviderView[] = [];
        for (const provider of this.registry.providers) {
            if (!this.canSee(provider, context)) continue;
            try {
                views.push(await this.view(provider, context));
            } catch (err) {
                // One failing provider does not hide the others
                logger.error("Config provider '%s' failed: %s", provider.id, (err as Error)?.message ?? err);
            }
        }
        return views;
    }

    async get(providerId: string, context: CliConfigContext): Promise<CliConfigProviderView> {
        this.requirePermission(context, CliConfigPermissions.Read);
        await this.ready();
        return this.view(this.provider(providerId, context), context);
    }

    async update(
        providerId: string,
        sectionId: string,
        request: CliConfigUpdateRequest,
        context: CliConfigContext,
    ): Promise<CliConfigUpdateResponse> {
        this.requirePermission(context, CliConfigPermissions.Write);
        await this.ready();
        const provider = this.provider(providerId, context);
        if (!isCliConfigWriter(provider)) throw new CliConfigError(400, `config provider ${provider.id} is read-only`);
        const changes = request?.changes;
        if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
            throw new CliConfigError(400, 'changes must be a non-empty object');
        }
        const expected = request.version;
        if (expected !== undefined && expected !== null && typeof expected !== 'string') {
            throw new CliConfigError(400, 'version must be a string');
        }
        const section = (await provider.getSections(context)).find((s) => s.id === sectionId);
        if (!section) throw new CliConfigError(404, `unknown config section: ${provider.id}.${sectionId}`);
        const before = toCliConfigSectionView(section, true);
        if (!before.mutable) throw new CliConfigError(400, `config section ${provider.id}.${sectionId} is read-only`);

        // The server's checks: the key exists and is mutable, the value has the type and passes the rules
        const errors: CliConfigErrors = {};
        for (const [key, value] of Object.entries(changes)) {
            const entry = section.entries.find((e) => e.key === key);
            if (!entry) {
                if (!before.allowCustomKeys) errors[key] = 'unknown setting';
                else if (!CLI_CONFIG_KEY.test(key)) errors[key] = 'invalid key: use letters, digits, _, - and .';
                else if (value !== null) {
                    const error = validateCliConfigValue({ type: 'json' }, value);
                    if (error) errors[key] = error;
                }
                continue;
            }
            if (entry.mutable !== true) {
                errors[key] = 'read-only';
                continue;
            }
            const error = validateCliConfigValue(entry, value);
            if (error) errors[key] = error;
        }
        if (Object.keys(errors).length === 0) {
            Object.assign(errors, await provider.validate(sectionId, changes as Record<string, CliConfigValue>, context));
        }
        if (Object.keys(errors).length > 0) throw new CliConfigError(400, 'validation failed', errors);
        if (typeof expected === 'string' && before.version !== null && expected !== before.version) {
            throw new CliConfigError(409, 'version conflict', undefined, before.version);
        }

        let result;
        try {
            result = await provider.update(sectionId, changes as Record<string, CliConfigValue>, expected ?? undefined, context);
        } catch (err) {
            if (err instanceof CliConfigConflictError || (err as Error)?.name === 'CliConfigConflictError') {
                throw new CliConfigError(409, 'version conflict', undefined, (err as CliConfigConflictError).currentVersion);
            }
            if (err instanceof CliConfigValidationError || (err as Error)?.name === 'CliConfigValidationError') {
                throw new CliConfigError(400, 'validation failed', (err as CliConfigValidationError).errors);
            }
            throw err;
        }

        const updated = (await provider.getSections(context)).find((s) => s.id === sectionId);
        const after = toCliConfigSectionView(updated ?? section, true);
        const auditChanges: CliConfigAuditChange[] = result.applied.map((key) => {
            const old = before.entries.find((e) => e.key === key);
            const now = after.entries.find((e) => e.key === key);
            const raw = (changes as Record<string, CliConfigValue>)[key];
            return { key, old: auditValue(old, undefined, 'old'), new: now || raw !== null ? auditValue(now ?? old, raw, 'new') : null };
        });
        await this.audit(provider.id, sectionId, result.version, auditChanges, context);
        await this.options.eventBus?.()?.publish(
            CLI_CONFIG_CHANGED_EVENT,
            {
                provider: provider.id,
                section: sectionId,
                keys: [...result.applied],
                version: result.version,
                requiresRestart: result.requiresRestart,
                ...(context.caller?.userName ? { user: context.caller.userName } : {}),
            },
            { permission: CliConfigPermissions.Read },
        );
        return {
            provider: provider.id,
            section: { ...after, ...(after.mutable ? { version: result.version } : {}) },
            applied: [...result.applied],
            requiresRestart: result.requiresRestart,
            version: result.version,
        };
    }

    private async audit(
        providerId: string,
        sectionId: string,
        version: string,
        changes: CliConfigAuditChange[],
        context: CliConfigContext,
    ): Promise<void> {
        const sink = this.options.audit?.();
        if (!sink) return;
        const userName = context.caller?.userName ?? 'anonymous';
        try {
            await sink({
                timestamp: Date.now(),
                event: CLI_CONFIG_AUDIT_EVENT,
                username: userName,
                ...(context.caller?.userId ? { userId: context.caller.userId, actorId: context.caller.userId } : {}),
                actor: userName,
                target: `config:${providerId}.${sectionId}`,
                details: `${providerId}.${sectionId}: ${changes.map((c) => c.key).join(', ')}`,
                properties: {
                    provider: providerId,
                    section: sectionId,
                    version,
                    ...(context.via ? { via: context.via } : {}),
                    changes,
                },
            });
        } catch (err) {
            logger.error('Auditing a config change failed: %s', (err as Error)?.message ?? err);
        }
    }
}
