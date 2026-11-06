import { randomUUID } from 'crypto';
import { AuditEntry, ICliAuditStore, ICliEventBus } from '@qodalis/cli-server-abstractions';
import { AuditPermissions } from './cli-audit-controller';

const PUBLISHING = Symbol.for('qodalis.cli.audit.publishing');

interface PublishingStore extends ICliAuditStore {
    [PUBLISHING]?: { eventBus?: ICliEventBus };
}

/**
 * Makes `store.log` publish `audit:recorded` (audience `audit:read`) after each entry is
 * stored, once an event bus is set with the returned function. The store keeps its
 * identity (`auditPlugin.store` is the store the host set), so entries a host logs
 * through it publish too. The event carries the entry as the audit API returns it;
 * its `timestamp` is the entry's time as ISO 8601 (the wire's reserved `timestamp`).
 */
export function publishAuditEntries(store: ICliAuditStore): (eventBus: ICliEventBus | undefined) => void {
    const target = store as PublishingStore;
    let state = target[PUBLISHING];
    if (!state) {
        const current: { eventBus?: ICliEventBus } = {};
        state = current;
        const log = store.log.bind(store);
        Object.defineProperty(target, PUBLISHING, { value: current });
        target.log = async (entry: AuditEntry): Promise<void> => {
            // The id is set here so the event names the entry the store keeps
            const stored: AuditEntry = { ...entry, id: entry.id ?? randomUUID(), timestamp: entry.timestamp ?? Date.now() };
            await log(stored);
            await current.eventBus?.publish('audit:recorded', { ...stored }, { permission: AuditPermissions.Read });
        };
    }
    const bound = state;
    return (eventBus) => {
        bound.eventBus = eventBus;
    };
}
