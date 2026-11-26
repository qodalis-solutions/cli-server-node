import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
    CLI_NOTIFICATION_CHANGED_EVENT,
    normalizeCliNotificationInput,
    type CliEventAudience,
    type CliNotification,
    type CliNotificationChange,
    type CliNotificationInput,
    type CliNotificationList,
    type ICliEventBus,
    type ICliNotifications,
} from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

const logger = createLogger('Notifications');

/** The file below the data directory. */
export const NOTIFICATIONS_FILE = 'notifications.json';
/** The most notifications kept (the oldest dropped first). */
export const DEFAULT_NOTIFICATIONS_MAX_ITEMS = 500;
/** How long a notification is kept after its last change. */
export const DEFAULT_NOTIFICATIONS_MAX_AGE_DAYS = 30;
/** The reader id of every caller on a server without sign-in (one shared read state). */
export const ANONYMOUS_NOTIFICATION_READER = 'anonymous';

/** Who reads: their id (read state) and what they may see. */
export interface CliNotificationViewer {
    userId: string;
    /** True when the viewer holds the permission (always on a server without sign-in). */
    can(permission: string): boolean;
}

/** The viewer of a server without sign-in: one reader who sees everything. */
export const ANONYMOUS_NOTIFICATION_VIEWER: CliNotificationViewer = { userId: ANONYMOUS_NOTIFICATION_READER, can: () => true };

/** The `notifications` option of `createCliServer`. */
export interface CliNotificationsOptions {
    /** The file they are kept in (default `<dataDir>/notifications.json`); `false` keeps them in memory. */
    file?: string | false;
    /** The most notifications kept (default 500). */
    maxItems?: number;
    /** Days a notification is kept after its last change (default 30). */
    maxAgeDays?: number;
}

/** A notification as the file keeps it. */
interface StoredNotification extends Omit<CliNotification, 'read'> {
    /** The readers who read it since its last change. */
    readBy: string[];
    /** The readers who dismissed it. */
    dismissedBy: string[];
}

interface NotificationsFile {
    version: 1;
    items: StoredNotification[];
}

/** The payload of `notification:changed` before it is personalised per socket (`unreadCount`, `item.read`). */
export interface CliNotificationChangedData extends Record<string, unknown> {
    action: CliNotificationChange;
    id?: string;
    key?: string;
    item?: Omit<CliNotification, 'read'>;
}

const contentOf = (n: Pick<StoredNotification, 'kind' | 'severity' | 'title' | 'message' | 'link' | 'requiredPermission' | 'data'>) =>
    JSON.stringify([n.kind, n.severity, n.title, n.message, n.link ?? null, n.requiredPermission ?? null, n.data ?? null]);

/**
 * The server's notifications (`builder.notifications`): sources publish with {@link notify} (a key updates its
 * notification) and {@link resolve} once the condition ended; users list, read and dismiss theirs. Kept in
 * `<dataDir>/notifications.json` (at most 500, 30 days after their last change), with each user's read and dismissed
 * state; every change is published as `notification:changed` (audience: the notification's permission, or the user
 * for read and dismiss).
 */
export class CliNotificationService implements ICliNotifications {
    private items: StoredNotification[] = [];
    private file: string | false = false;
    private maxItems = DEFAULT_NOTIFICATIONS_MAX_ITEMS;
    private maxAgeMs = DEFAULT_NOTIFICATIONS_MAX_AGE_DAYS * 86_400_000;
    private eventBus?: () => ICliEventBus | undefined;
    private readonly now: () => Date;

    constructor(options: CliNotificationsOptions & { eventBus?: () => ICliEventBus | undefined; now?: () => Date } = {}) {
        this.now = options.now ?? (() => new Date());
        this.configure(options);
    }

    /**
     * Sets where they are kept and the limits (`createCliServer` calls it once, before plugins publish). The file's
     * notifications are loaded; those published before (in memory) win over the file's of the same key.
     */
    configure(options: CliNotificationsOptions & { eventBus?: () => ICliEventBus | undefined } = {}): this {
        if (options.maxItems !== undefined) {
            if (!Number.isInteger(options.maxItems) || options.maxItems < 1) throw new Error('notifications.maxItems must be an integer >= 1');
            this.maxItems = options.maxItems;
        }
        if (options.maxAgeDays !== undefined) {
            if (!(options.maxAgeDays > 0)) throw new Error('notifications.maxAgeDays must be > 0');
            this.maxAgeMs = options.maxAgeDays * 86_400_000;
        }
        if (options.eventBus) this.eventBus = options.eventBus;
        if (options.file !== undefined && options.file !== this.file) {
            this.file = options.file;
            const loaded = this.readFile();
            const mine = new Set(this.items.map((n) => n.key));
            this.items = [...this.items, ...loaded.filter((n) => !mine.has(n.key))];
            if (this.prune()) this.save();
        }
        return this;
    }

    /** The file they are kept in; false in memory. */
    get path(): string | false {
        return this.file;
    }

    // ---------------------------------------------------------------- sources

    notify(input: CliNotificationInput): CliNotification {
        const n = normalizeCliNotificationInput(input);
        const now = this.now().toISOString();
        const existing = this.items.find((x) => x.key === n.key);
        if (existing) {
            if (contentOf(existing) === contentOf(n)) return this.view(existing, undefined);
            existing.kind = n.kind;
            existing.severity = n.severity;
            existing.title = n.title;
            existing.message = n.message;
            setOptional(existing, 'link', n.link);
            setOptional(existing, 'requiredPermission', n.requiredPermission);
            setOptional(existing, 'data', n.data);
            existing.updatedAt = now;
            // Changed: unread (and shown) again for everyone
            existing.readBy = [];
            existing.dismissedBy = [];
            this.changed('updated', existing);
            return this.view(existing, undefined);
        }
        const stored: StoredNotification = {
            id: `n_${randomBytes(8).toString('hex')}`,
            ...n,
            createdAt: now,
            updatedAt: now,
            readBy: [],
            dismissedBy: [],
        };
        this.items.push(stored);
        this.prune();
        this.changed('created', stored);
        return this.view(stored, undefined);
    }

    resolve(key: string): boolean {
        const i = this.items.findIndex((x) => x.key === key);
        if (i < 0) return false;
        const [removed] = this.items.splice(i, 1);
        this.changed('resolved', removed);
        return true;
    }

    resolveMissing(prefix: string, keep: Iterable<string>): number {
        const kept = new Set(keep);
        const gone = this.items.filter((x) => x.key.startsWith(prefix) && !kept.has(x.key)).map((x) => x.key);
        for (const key of gone) this.resolve(key);
        return gone.length;
    }

    get(key: string): Omit<CliNotification, 'read'> | undefined {
        const n = this.items.find((x) => x.key === key);
        return n ? this.base(n) : undefined;
    }

    // ---------------------------------------------------------------- readers

    /** What the viewer sees, newest first; `unread` only the unread ones, `limit` at most so many. */
    list(viewer: CliNotificationViewer, options: { unread?: boolean; limit?: number; severity?: string } = {}): CliNotificationList {
        const visible = this.visibleTo(viewer);
        let items = visible.map((n) => this.view(n, viewer.userId));
        if (options.unread) items = items.filter((n) => !n.read);
        if (options.severity) items = items.filter((n) => n.severity === options.severity);
        if (options.limit !== undefined && options.limit >= 0) items = items.slice(0, options.limit);
        return { items, unreadCount: visible.filter((n) => !n.readBy.includes(viewer.userId)).length };
    }

    /** The viewer's unread notifications. */
    unreadCount(viewer: CliNotificationViewer): number {
        return this.visibleTo(viewer).filter((n) => !n.readBy.includes(viewer.userId)).length;
    }

    /** One notification as the viewer sees it; undefined when it does not exist, is hidden from them or was dismissed. */
    find(viewer: CliNotificationViewer, id: string): CliNotification | undefined {
        const n = this.visibleTo(viewer).find((x) => x.id === id);
        return n ? this.view(n, viewer.userId) : undefined;
    }

    /** Marks one read for the viewer; undefined when they cannot see it. */
    markRead(viewer: CliNotificationViewer, id: string): CliNotification | undefined {
        const n = this.visibleTo(viewer).find((x) => x.id === id);
        if (!n) return undefined;
        if (!n.readBy.includes(viewer.userId)) {
            n.readBy.push(viewer.userId);
            this.changed('read', n, viewer.userId);
        }
        return this.view(n, viewer.userId);
    }

    /** Marks every notification the viewer sees read; returns how many were unread. */
    markAllRead(viewer: CliNotificationViewer): number {
        const unread = this.visibleTo(viewer).filter((n) => !n.readBy.includes(viewer.userId));
        for (const n of unread) n.readBy.push(viewer.userId);
        if (unread.length) this.changed('read-all', undefined, viewer.userId);
        return unread.length;
    }

    /** Hides one from the viewer (it comes back when its content changes); false when they cannot see it. */
    dismiss(viewer: CliNotificationViewer, id: string): boolean {
        const n = this.visibleTo(viewer).find((x) => x.id === id);
        if (!n) return false;
        n.dismissedBy.push(viewer.userId);
        if (!n.readBy.includes(viewer.userId)) n.readBy.push(viewer.userId);
        this.changed('dismissed', n, viewer.userId);
        return true;
    }

    /** Removes one for everyone (`notifications:manage`); false when the viewer cannot see it. */
    clear(viewer: CliNotificationViewer, id: string): boolean {
        const i = this.items.findIndex((x) => x.id === id && this.canSee(viewer, x));
        if (i < 0) return false;
        const [removed] = this.items.splice(i, 1);
        this.changed('cleared', removed);
        return true;
    }

    /** The event's item with the reader's read flag (the events socket personalises each message with it). */
    readFlag(id: string | undefined, userId: string): boolean {
        const n = id ? this.items.find((x) => x.id === id) : undefined;
        return !!n && n.readBy.includes(userId);
    }

    // ---------------------------------------------------------------- internals

    private canSee(viewer: CliNotificationViewer, n: StoredNotification): boolean {
        return !n.requiredPermission || viewer.can(n.requiredPermission);
    }

    private visibleTo(viewer: CliNotificationViewer): StoredNotification[] {
        this.prune();
        return this.items
            .filter((n) => this.canSee(viewer, n) && !n.dismissedBy.includes(viewer.userId))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
    }

    private base(n: StoredNotification): Omit<CliNotification, 'read'> {
        const { readBy: _r, dismissedBy: _d, ...rest } = n;
        return { ...rest, ...(rest.data ? { data: JSON.parse(JSON.stringify(rest.data)) as Record<string, unknown> } : {}) };
    }

    private view(n: StoredNotification, userId: string | undefined): CliNotification {
        return { ...this.base(n), read: userId !== undefined && n.readBy.includes(userId) };
    }

    /** Drops the notifications past their age and over the cap (oldest first); true when it dropped some. */
    private prune(): boolean {
        const before = this.items.length;
        const cutoff = this.now().getTime() - this.maxAgeMs;
        this.items = this.items.filter((n) => Date.parse(n.updatedAt) >= cutoff);
        if (this.items.length > this.maxItems) {
            this.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            this.items = this.items.slice(0, this.maxItems);
        }
        return this.items.length !== before;
    }

    private changed(action: CliNotificationChange, n: StoredNotification | undefined, userId?: string): void {
        this.save();
        const bus = this.eventBus?.();
        if (!bus) return;
        const data: CliNotificationChangedData = {
            action,
            ...(n ? { id: n.id, key: n.key } : {}),
            ...(n && action !== 'resolved' && action !== 'cleared' ? { item: this.base(n) } : {}),
        };
        // Read and dismiss concern one user; the rest everyone who may see the notification
        const audience: CliEventAudience = userId ? { userId } : n?.requiredPermission ? { permission: n.requiredPermission } : {};
        void bus.publish(CLI_NOTIFICATION_CHANGED_EVENT, data, audience);
    }

    private readFile(): StoredNotification[] {
        if (!this.file || !existsSync(this.file)) return [];
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<NotificationsFile>;
            if (!Array.isArray(parsed?.items)) return [];
            const items: StoredNotification[] = [];
            for (const raw of parsed.items) {
                try {
                    const n = normalizeCliNotificationInput(raw as CliNotificationInput);
                    const r = raw as Partial<StoredNotification>;
                    if (typeof r.id !== 'string' || typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string') continue;
                    items.push({
                        ...n,
                        id: r.id,
                        createdAt: r.createdAt,
                        updatedAt: r.updatedAt,
                        readBy: Array.isArray(r.readBy) ? r.readBy.filter((x) => typeof x === 'string') : [],
                        dismissedBy: Array.isArray(r.dismissedBy) ? r.dismissedBy.filter((x) => typeof x === 'string') : [],
                    });
                } catch {
                    // a damaged entry is dropped
                }
            }
            return items;
        } catch (err) {
            logger.warn('Reading %s failed, starting without notifications: %s', this.file, (err as Error).message);
            return [];
        }
    }

    /** Writes the file atomically (a temporary file renamed over it). */
    private save(): void {
        if (!this.file) return;
        const file = this.file;
        const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
            mkdirSync(dirname(file), { recursive: true });
            const body: NotificationsFile = { version: 1, items: this.items };
            writeFileSync(tmp, JSON.stringify(body, null, 2));
            renameSync(tmp, file);
        } catch (err) {
            logger.warn('Saving %s failed: %s', file, (err as Error).message);
            try {
                unlinkSync(tmp);
            } catch {
                // nothing written
            }
        }
    }
}

function setOptional<K extends 'link' | 'requiredPermission' | 'data'>(target: StoredNotification, key: K, value: StoredNotification[K] | undefined): void {
    if (value === undefined) delete target[key];
    else target[key] = value;
}
