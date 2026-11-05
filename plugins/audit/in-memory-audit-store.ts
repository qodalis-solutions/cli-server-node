import { randomUUID } from 'crypto';
import { AuditEntry, AuditQueryOptions, ICliAuditStore } from '@qodalis/cli-server-abstractions';

/** The event of a failed sign-in (users plugin), kept apart so a flood of them keeps the rest. */
export const FAILED_LOGIN_EVENT = 'login_failed';

/** Entries kept by default, other than `login_failed`. */
export const DEFAULT_MAX_AUDIT_ENTRIES = 1000;

/** `login_failed` entries kept by default. */
export const DEFAULT_MAX_FAILED_LOGIN_ENTRIES = 200;

interface Stored {
    seq: number;
    entry: AuditEntry;
}

/**
 * In-memory audit log: the latest 1000 entries. `login_failed` entries are capped
 * separately (latest 200) so a flood of failed sign-ins cannot evict the rest of
 * the history.
 */
export class InMemoryAuditStore implements ICliAuditStore {
    private entries: Stored[] = [];
    private failedLogins: Stored[] = [];
    private seq = 0;
    readonly maxEntries: number;
    readonly maxFailedLoginEntries: number;

    constructor(maxEntries: number = DEFAULT_MAX_AUDIT_ENTRIES, maxFailedLoginEntries: number = DEFAULT_MAX_FAILED_LOGIN_ENTRIES) {
        this.maxEntries = maxEntries > 0 ? maxEntries : DEFAULT_MAX_AUDIT_ENTRIES;
        this.maxFailedLoginEntries = maxFailedLoginEntries > 0 ? maxFailedLoginEntries : DEFAULT_MAX_FAILED_LOGIN_ENTRIES;
    }

    async log(entry: AuditEntry): Promise<void> {
        const stored: Stored = {
            seq: this.seq++,
            entry: { id: entry.id ?? randomUUID(), ...entry, timestamp: entry.timestamp ?? Date.now() },
        };
        if (entry.event === FAILED_LOGIN_EVENT) {
            this.failedLogins.push(stored);
            while (this.failedLogins.length > this.maxFailedLoginEntries) this.failedLogins.shift();
        } else {
            this.entries.push(stored);
            while (this.entries.length > this.maxEntries) this.entries.shift();
        }
    }

    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> {
        // Newest first (recording order)
        let result = [...this.entries, ...this.failedLogins].sort((a, b) => b.seq - a.seq).map((s) => s.entry);

        if (options?.event) {
            const event = options.event.toLowerCase();
            result = result.filter((e) => e.event.toLowerCase() === event);
        }

        if (options?.username) {
            const username = options.username.toLowerCase();
            result = result.filter((e) => e.username?.toLowerCase() === username);
        }

        if (options?.actor) {
            const actor = options.actor.toLowerCase();
            result = result.filter((e) => e.actor?.toLowerCase() === actor);
        }

        if (options?.offset !== undefined && options.offset > 0) {
            result = result.slice(options.offset);
        }

        if (options?.limit !== undefined && options.limit > 0) {
            result = result.slice(0, options.limit);
        }

        return result;
    }

    async prune(before: Date): Promise<number> {
        const cutoff = before.getTime();
        const count = this.entries.length + this.failedLogins.length;
        this.entries = this.entries.filter((s) => s.entry.timestamp >= cutoff);
        this.failedLogins = this.failedLogins.filter((s) => s.entry.timestamp >= cutoff);
        return count - this.entries.length - this.failedLogins.length;
    }

    async clear(): Promise<void> {
        this.entries = [];
        this.failedLogins = [];
    }
}
