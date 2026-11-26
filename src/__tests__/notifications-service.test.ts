import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_NOTIFICATION_CHANGED_EVENT, type CliEvent } from '@qodalis/cli-server-abstractions';
import { CliEventBus } from '../services';
import { CliNotificationService, type CliNotificationViewer } from '../notifications';

const dirs: string[] = [];
const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'qcli-notif-'));
    dirs.push(d);
    return d;
};
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const viewer = (userId: string, permissions: string[] = []): CliNotificationViewer => ({
    userId,
    can: (p) => permissions.includes('*') || permissions.includes(p),
});
const alice = viewer('alice', ['admin:access']);
const bob = viewer('bob');

const input = (key: string, extra: Record<string, unknown> = {}) => ({ key, kind: 'test', severity: 'info' as const, title: `Title ${key}`, message: 'Details', ...extra });

describe('CliNotificationService', () => {
    it('dedupes by key: the same key updates the notification, identical content changes nothing', () => {
        const bus = new CliEventBus();
        const events: CliEvent[] = [];
        bus.subscribe(CLI_NOTIFICATION_CHANGED_EVENT, (e) => void events.push(e));
        let now = new Date('2026-11-26T10:00:00Z');
        const s = new CliNotificationService({ eventBus: () => bus, now: () => now });
        const first = s.notify(input('a'));
        expect(first).toMatchObject({ key: 'a', kind: 'test', severity: 'info', title: 'Title a', read: false });
        expect(first.id).toMatch(/^n_[0-9a-f]{16}$/);

        s.markRead(alice, first.id);
        // identical: no update, still read, no event
        s.notify(input('a'));
        expect(s.list(alice).items).toHaveLength(1);
        expect(s.list(alice).items[0].read).toBe(true);

        now = new Date('2026-11-26T11:00:00Z');
        const updated = s.notify(input('a', { severity: 'warning', title: 'Changed' }));
        expect(updated.id).toBe(first.id);
        expect(updated.createdAt).toBe('2026-11-26T10:00:00.000Z');
        expect(updated.updatedAt).toBe('2026-11-26T11:00:00.000Z');
        // changed content is unread again
        expect(s.list(alice)).toMatchObject({ unreadCount: 1, items: [{ title: 'Changed', severity: 'warning', read: false }] });
        expect(events.map((e) => e.data.action)).toEqual(['created', 'read', 'updated']);
    });

    it('resolve removes the notification of a key; resolveMissing keeps only the listed keys of a prefix', () => {
        const s = new CliNotificationService();
        s.notify(input('update:a'));
        s.notify(input('update:b'));
        s.notify(input('other'));
        expect(s.resolve('update:a')).toBe(true);
        expect(s.resolve('update:a')).toBe(false);
        s.notify(input('update:c'));
        expect(s.resolveMissing('update:', ['update:c'])).toBe(1);
        expect(s.list(alice).items.map((n) => n.key).sort()).toEqual(['other', 'update:c']);
        expect(s.get('update:b')).toBeUndefined();
    });

    it('filters by requiredPermission', () => {
        const s = new CliNotificationService();
        s.notify(input('public'));
        s.notify(input('admin', { requiredPermission: 'admin:access' }));
        expect(s.list(alice).items.map((n) => n.key).sort()).toEqual(['admin', 'public']);
        expect(s.list(bob).items.map((n) => n.key)).toEqual(['public']);
        expect(s.unreadCount(bob)).toBe(1);
        // a hidden one cannot be read, dismissed or cleared either
        const hidden = s.get('admin')!;
        expect(s.markRead(bob, hidden.id)).toBeUndefined();
        expect(s.dismiss(bob, hidden.id)).toBe(false);
        expect(s.clear(bob, hidden.id)).toBe(false);
    });

    it('keeps the read state per user; read-all and dismiss affect only that user', () => {
        const s = new CliNotificationService();
        const a = s.notify(input('a'));
        s.notify(input('b'));
        s.markRead(alice, a.id);
        expect(s.unreadCount(alice)).toBe(1);
        expect(s.unreadCount(bob)).toBe(2);
        expect(s.list(alice, { unread: true }).items.map((n) => n.key)).toEqual(['b']);
        expect(s.markAllRead(bob)).toBe(2);
        expect(s.unreadCount(bob)).toBe(0);
        expect(s.unreadCount(alice)).toBe(1);

        expect(s.dismiss(alice, a.id)).toBe(true);
        expect(s.list(alice).items.map((n) => n.key)).toEqual(['b']);
        expect(s.list(bob).items).toHaveLength(2);
        // clear removes it for everyone
        expect(s.clear(bob, a.id)).toBe(true);
        expect(s.list(bob).items.map((n) => n.key)).toEqual(['b']);
    });

    it('a dismissed notification comes back when its content changes', () => {
        const s = new CliNotificationService();
        const a = s.notify(input('a'));
        s.dismiss(alice, a.id);
        expect(s.list(alice).items).toHaveLength(0);
        s.notify(input('a', { message: 'New details' }));
        expect(s.list(alice).items).toMatchObject([{ key: 'a', read: false, message: 'New details' }]);
    });

    it('lists newest first and filters by severity and limit', () => {
        let t = Date.parse('2026-11-26T10:00:00Z');
        const s = new CliNotificationService({ now: () => new Date((t += 1000)) });
        s.notify(input('a'));
        s.notify(input('b', { severity: 'error' }));
        s.notify(input('c'));
        expect(s.list(alice).items.map((n) => n.key)).toEqual(['c', 'b', 'a']);
        expect(s.list(alice, { severity: 'error' }).items.map((n) => n.key)).toEqual(['b']);
        expect(s.list(alice, { limit: 2 }).items.map((n) => n.key)).toEqual(['c', 'b']);
        expect(s.list(alice, { limit: 2 }).unreadCount).toBe(3);
    });

    it('persists across a restart, read and dismissed state included', () => {
        const file = join(temp(), 'data', 'notifications.json');
        const s1 = new CliNotificationService({ file });
        const a = s1.notify(input('a', { requiredPermission: 'admin:access', link: '/plugins', data: { n: 1 } }));
        const b = s1.notify(input('b'));
        s1.markRead(alice, a.id);
        s1.dismiss(bob, b.id);
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        expect(saved.version).toBe(1);
        expect(saved.items).toHaveLength(2);

        const s2 = new CliNotificationService({ file });
        expect(s2.list(alice).items.find((n) => n.key === 'a')).toMatchObject({ id: a.id, read: true, link: '/plugins', data: { n: 1 } });
        expect(s2.list(bob).items).toHaveLength(0);
        expect(s2.resolve('a')).toBe(true);
        expect(new CliNotificationService({ file }).get('a')).toBeUndefined();
    });

    it('caps the list and drops notifications 30 days after their last change', () => {
        let now = new Date('2026-11-01T00:00:00Z');
        const s = new CliNotificationService({ maxItems: 3, now: () => now });
        for (const k of ['a', 'b', 'c', 'd']) {
            now = new Date(now.getTime() + 60_000);
            s.notify(input(k));
        }
        expect(s.list(alice).items.map((n) => n.key)).toEqual(['d', 'c', 'b']);
        now = new Date('2026-12-01T00:02:30Z');
        expect(s.list(alice).items.map((n) => n.key)).toEqual(['d', 'c']);
        now = new Date('2026-12-02T00:00:00Z');
        expect(s.list(alice).items).toHaveLength(0);
    });

    it('ignores a damaged file and damaged entries', () => {
        const dir = temp();
        const bad = join(dir, 'bad.json');
        writeFileSync(bad, '{ not json');
        expect(new CliNotificationService({ file: bad }).list(alice).items).toEqual([]);
        const partial = join(dir, 'partial.json');
        const now = new Date().toISOString();
        writeFileSync(
            partial,
            JSON.stringify({ version: 1, items: [{ id: 'n_1', key: 'ok', kind: 'k', severity: 'info', title: 'T', message: '', createdAt: now, updatedAt: now }, { key: 'broken' }] }),
        );
        expect(new CliNotificationService({ file: partial }).list(alice).items.map((n) => n.key)).toEqual(['ok']);
    });

    it('refuses invalid input', () => {
        const s = new CliNotificationService();
        expect(() => s.notify(input('bad key with spaces'))).toThrow(/key/);
        expect(() => s.notify(input('k', { severity: 'fatal' }))).toThrow(/severity/);
        expect(() => s.notify(input('k', { title: '' }))).toThrow(/title/);
        expect(() => s.notify(input('k', { link: 'javascript:alert(1)' }))).toThrow(/link/);
        expect(() => s.notify(input('k', { link: '//evil.test' }))).toThrow(/link/);
        expect(() => s.notify(input('k', { requiredPermission: 'admin' }))).toThrow(/requiredPermission/);
        expect(() => s.notify(input('k', { data: { big: 'x'.repeat(9000) } }))).toThrow(/8 KB/);
        expect(s.notify(input('k', { link: 'https://example.test/x' })).link).toBe('https://example.test/x');
    });

    it('publishes notification:changed with the item, to the permission or the user', async () => {
        const bus = new CliEventBus();
        const events: CliEvent[] = [];
        bus.subscribe(CLI_NOTIFICATION_CHANGED_EVENT, (e) => void events.push(e));
        const s = new CliNotificationService({ eventBus: () => bus });
        const n = s.notify(input('a', { requiredPermission: 'admin:access' }));
        s.markRead(alice, n.id);
        s.resolve('a');
        await new Promise((r) => setImmediate(r));
        expect(events.map((e) => [e.data.action, e.audience])).toEqual([
            ['created', { permission: 'admin:access' }],
            ['read', { userId: 'alice' }],
            ['resolved', { permission: 'admin:access' }],
        ]);
        expect(events[0].data.item).toMatchObject({ id: n.id, key: 'a', title: 'Title a' });
        expect(events[2].data.item).toBeUndefined();
    });
});
