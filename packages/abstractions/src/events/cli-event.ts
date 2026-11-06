/**
 * Who receives an event over the events WebSocket (never sent on the wire).
 * Empty: everyone. `permission`: sockets whose principal holds it. `userId`: sockets
 * of that user. Both: that user or anyone with the permission. On a server without
 * authentication every socket receives every event; in-process subscribers always do.
 */
export interface CliEventAudience {
    permission?: string;
    userId?: string;
}

/** A server event as in-process subscribers receive it. */
export interface CliEvent {
    /** `namespace:name`, e.g. `job:completed`. */
    type: string;
    /** ISO 8601 UTC. */
    timestamp: string;
    /** The publisher's fields (merged into the wire message). */
    data: Record<string, unknown>;
    audience: CliEventAudience;
}

/** Handler of {@link ICliEventBus.subscribe}. */
export type CliEventHandler = (event: CliEvent) => void | Promise<void>;

/**
 * The server's event bus. The events WebSocket is one subscriber of `*` that applies
 * each event's audience; plugins and host apps subscribe to react in code.
 */
export interface ICliEventBus {
    /**
     * Publishes an event. Never rejects: handler errors are logged and the other
     * handlers still run (in subscription order); resolves when they all completed.
     */
    publish(type: string, data?: Record<string, unknown>, audience?: CliEventAudience): Promise<void>;
    /** Subscribes to `*`, `ns:*` or an exact type; returns the unsubscribe function. */
    subscribe(pattern: string, handler: CliEventHandler): () => void;
}

/** A function sending one raw message to the events sockets (the pre-bus plugin parameter). */
export type CliEventBroadcastFn = (message: Record<string, unknown>) => void;

/** `*` matches everything, `ns:*` every type starting with `ns:`, anything else must equal the type. */
export function cliEventPatternMatches(type: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith(':*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
}

/** The flat wire message of an event: `{ type, timestamp, ...data }` (`type` and `timestamp` win). */
export function toCliEventMessage(event: Pick<CliEvent, 'type' | 'timestamp' | 'data'>): Record<string, unknown> {
    return { ...event.data, type: event.type, timestamp: event.timestamp };
}

/** True for an {@link ICliEventBus} (duck-typed: plugins may hold another copy of this package). */
export function isCliEventBus(value: unknown): value is ICliEventBus {
    const bus = value as Partial<ICliEventBus> | undefined;
    return !!bus && typeof bus.publish === 'function' && typeof bus.subscribe === 'function';
}

/**
 * Builds the {@link CliEvent} a bus delivers: `timestamp` from the data when the
 * publisher set one (an ISO string, or epoch milliseconds), otherwise now.
 */
export function createCliEvent(type: string, data?: Record<string, unknown>, audience?: CliEventAudience): CliEvent {
    const { type: _type, timestamp, ...rest } = data ?? {};
    return { type, timestamp: toIsoTimestamp(timestamp), data: rest, audience: { ...(audience ?? {}) } };
}

function toIsoTimestamp(value: unknown): string {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    return new Date().toISOString();
}

/**
 * A bus for plugins built with a raw broadcast function instead of the server's bus:
 * each event goes to `broadcast` as its flat wire message (the audience is dropped;
 * `CliEventSocketManager.broadcastMessage` applies its per-type defaults), then to
 * the bus's own subscribers.
 */
export function cliEventBusFromBroadcast(broadcast: CliEventBroadcastFn): ICliEventBus {
    const handlers: Array<{ pattern: string; handler: CliEventHandler }> = [];
    return {
        async publish(type, data, audience) {
            const event = createCliEvent(type, data, audience);
            try {
                broadcast(toCliEventMessage(event));
            } catch (err) {
                console.error(`[events] broadcasting ${type} failed:`, err);
            }
            for (const entry of [...handlers]) {
                if (!cliEventPatternMatches(type, entry.pattern)) continue;
                try {
                    await entry.handler(event);
                } catch (err) {
                    console.error(`[events] handler of ${entry.pattern} failed for ${type}:`, err);
                }
            }
        },
        subscribe(pattern, handler) {
            const entry = { pattern, handler };
            handlers.push(entry);
            return () => {
                const i = handlers.indexOf(entry);
                if (i >= 0) handlers.splice(i, 1);
            };
        },
    };
}

/** The bus behind a plugin's events parameter: the bus itself, a bus over a broadcast function, or none. */
export function resolveCliEventBus(target: ICliEventBus | CliEventBroadcastFn | undefined): ICliEventBus | undefined {
    if (!target) return undefined;
    if (isCliEventBus(target)) return target;
    if (typeof target === 'function') return cliEventBusFromBroadcast(target);
    return undefined;
}

/** Permissions the server's events need (audiences of the event catalog). */
export const CliEventPermissions = {
    JobsRead: 'jobs:read',
    UsersRead: 'users:read',
    GroupsRead: 'groups:read',
    TokensRead: 'tokens:read',
    SessionsRead: 'sessions:read',
    FilesRead: 'files:read',
    AuditRead: 'audit:read',
    LogsRead: 'logs:read',
} as const;
