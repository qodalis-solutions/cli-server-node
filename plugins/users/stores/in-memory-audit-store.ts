import { randomUUID } from 'crypto';
import { AuditEntry, AuditQueryOptions } from '../models';
import { ICliAuditStore } from './interfaces';

const MAX_ENTRIES = 1000;
const MAX_FAILED_LOGIN_ENTRIES = 200;

interface Stored {
    seq: number;
    entry: AuditEntry;
}

/**
 * In-memory audit log. `login_failed` entries are capped separately (last 200)
 * so a flood of failed logins cannot evict the rest of the history (last 1000).
 */
export class InMemoryAuditStore implements ICliAuditStore {
    private entries: Stored[] = [];
    private failedLogins: Stored[] = [];
    private seq = 0;

    constructor(
        private readonly maxEntries: number = MAX_ENTRIES,
        private readonly maxFailedLoginEntries: number = MAX_FAILED_LOGIN_ENTRIES,
    ) {}

    async log(entry: AuditEntry): Promise<void> {
        const stored: Stored = {
            seq: this.seq++,
            entry: { id: entry.id ?? randomUUID(), ...entry, timestamp: entry.timestamp ?? Date.now() },
        };
        if (entry.event === 'login_failed') {
            this.failedLogins.push(stored);
            while (this.failedLogins.length > this.maxFailedLoginEntries) this.failedLogins.shift();
        } else {
            this.entries.push(stored);
            while (this.entries.length > this.maxEntries) this.entries.shift();
        }
    }

    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> {
        // Newest first
        let result = [...this.entries, ...this.failedLogins].sort((a, b) => b.seq - a.seq).map((s) => s.entry);

        if (options?.event) {
            const event = options.event.toLowerCase();
            result = result.filter((e) => e.event.toLowerCase() === event);
        }

        if (options?.username) {
            const username = options.username.toLowerCase();
            result = result.filter((e) => e.username?.toLowerCase() === username);
        }

        if (options?.limit !== undefined && options.limit > 0) {
            result = result.slice(0, options.limit);
        }

        return result;
    }

    async clear(): Promise<void> {
        this.entries = [];
        this.failedLogins = [];
    }
}
