import { AuditEntry } from './audit-entry';
import { AuditQueryOptions } from './audit-query-options';

/**
 * Where the audit log is kept. The audit plugin (`@qodalis/cli-server-plugin-audit`)
 * keeps it in memory by default; implement this to keep it elsewhere.
 */
export interface ICliAuditStore {
    log(entry: AuditEntry): Promise<void>;
    /** Newest first. */
    getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]>;
    clear(): Promise<void>;
    /**
     * Deletes the entries recorded before `before`; returns how many. Run it on a
     * schedule to keep the log bounded. Optional: a store without it keeps everything
     * (`pruneAudit` returns 0).
     */
    prune?(before: Date): Promise<number>;
}

/** Deletes the audit entries recorded before `before` (`store.prune`); 0 when the store keeps everything. */
export async function pruneAudit(store: ICliAuditStore, before: Date): Promise<number> {
    return store.prune ? store.prune(before) : 0;
}
