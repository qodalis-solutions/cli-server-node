import { randomUUID } from 'crypto';
import { AuditEntry, AuditQueryOptions } from '../models';
import { ICliAuditStore } from './interfaces';

const MAX_ENTRIES = 1000;

export class InMemoryAuditStore implements ICliAuditStore {
    private entries: AuditEntry[] = [];

    constructor(private readonly maxEntries: number = MAX_ENTRIES) {}

    async log(entry: AuditEntry): Promise<void> {
        this.entries.push({ id: entry.id ?? randomUUID(), ...entry, timestamp: entry.timestamp ?? Date.now() });
        while (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> {
        // Newest first
        let result = [...this.entries].reverse();

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
    }
}
