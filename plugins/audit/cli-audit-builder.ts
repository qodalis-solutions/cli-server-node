import { Router } from 'express';
import { CliInstalledPlugin, ICliAuditStore } from '@qodalis/cli-server-abstractions';
import { InMemoryAuditStore } from './in-memory-audit-store';
import { CliAuditGuard, createAuditController } from './cli-audit-controller';
import { auditInstalledPlugin } from './package-info';

export interface CliAuditPluginResult {
    /** Mount prefix (`/api/v1/qcli/audit`). */
    prefix: '/api/v1/qcli/audit';
    /** The audit API (`GET` / `DELETE`). */
    router: Router;
    /** Where the log is kept: record a host's own events here (`store.log(...)`). */
    store: ICliAuditStore;
    /** This package, listed among the server's installed plugins by `mountPlugin`. */
    installedPlugin: CliInstalledPlugin;
    /**
     * Protects the routes with `guard` (replacing any earlier one). The users plugin
     * protects the audit plugin it serves with its own sign-in and permissions.
     */
    protect(guard: CliAuditGuard | undefined): void;
}

/**
 * Fluent builder for the audit plugin: the audit log, its store (in memory, the
 * latest 1000 entries, unless one is set) and its API at `/api/v1/qcli/audit`,
 * shown as the admin dashboard's Audit page. The users plugin adds it and records
 * sign-ins, user, group and token changes there; a host records its own changes
 * through `store`.
 *
 * @example
 * ```ts
 * import { CliAuditBuilder } from '@qodalis/cli-server-plugin-audit';
 *
 * const auditPlugin = new CliAuditBuilder().setStore(new MyAuditStore()).build();
 * mountPlugin(auditPlugin);
 * ```
 */
export class CliAuditBuilder {
    private _store?: ICliAuditStore;
    private _guard?: CliAuditGuard;

    /** Keeps the log in `store` (default: an `InMemoryAuditStore`). */
    setStore(store: ICliAuditStore): this {
        this._store = store;
        return this;
    }

    /** Protects the routes with `guard` (see {@link CliAuditPluginResult.protect}). */
    setGuard(guard: CliAuditGuard): this {
        this._guard = guard;
        return this;
    }

    build(): CliAuditPluginResult {
        const store = this._store ?? new InMemoryAuditStore();
        let guard = this._guard;
        const router = createAuditController(store, () => guard);
        return {
            prefix: '/api/v1/qcli/audit',
            router,
            store,
            installedPlugin: auditInstalledPlugin,
            protect: (next) => {
                guard = next;
            },
        };
    }
}
