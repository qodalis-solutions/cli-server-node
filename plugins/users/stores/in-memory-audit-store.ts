import { AuditEntry, AuditQueryOptions } from '../models';
import { ICliAuditStore } from './interfaces';

const MAX_ENTRIES = 1000;

export class InMemoryAuditStore implements ICliAuditStore {
    private entries: AuditEntry[] = [];

    async log(entry: AuditEntry): Promise<void> {
        this.entries.push(entry);
        if (this.entries.length > MAX_ENTRIES) {
            this.entries.shift();
        }
    }

    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> {
        // Return newest-first
        let result = [...this.entries].reverse();

        if (options?.event) {
            result = result.filter((e) => e.event === options.event);
        }

        if (options?.username) {
            result = result.filter((e) => e.username === options.username);
        }

        if (options?.limit !== undefined && options.limit > 0) {
            result = result.slice(0, options.limit);
        }

        return result;
    }

    async clear(): Promise<void> {
        this.entries = [];
    }
}
