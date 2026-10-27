/**
 * The generated root password is printed once to stderr and never goes through
 * `console`, so the admin plugin's log buffer (served to the dashboard and
 * broadcast on the log/event sockets) never sees it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CliUsersBuilder } from '../../plugins/users/index';
import { LogRingBuffer, redactSecrets } from '../../plugins/admin/services/log-ring-buffer';

describe('generated root password', () => {
    let buffer: LogRingBuffer | undefined;

    afterEach(() => {
        buffer?.restoreConsole();
        buffer = undefined;
        vi.restoreAllMocks();
    });

    it('is printed to stderr but never reaches the intercepted console, the log buffer or a broadcast', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        // installed before the interceptor, so it sees everything written through console
        const consoleCalls: string[] = [];
        for (const method of ['log', 'info', 'warn', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
                consoleCalls.push(args.map(String).join(' '));
            });
        }
        buffer = new LogRingBuffer();
        const broadcasts: Record<string, unknown>[] = [];
        buffer.setBroadcastFn((msg) => broadcasts.push(msg));
        buffer.interceptConsole();

        const plugin = new CliUsersBuilder().build();
        await plugin.ready;
        buffer.restoreConsole();

        const written = [...stderr.mock.calls.map((c) => String(c[0])), ...consoleCalls];
        const line = written.find((m) => m.includes('Generated password'));
        expect(line).toBeDefined();
        const password = /root": (\S{16}) /.exec(line!)![1];

        expect(stderr.mock.calls.some((c) => String(c[0]).includes(password))).toBe(true);
        expect(consoleCalls.some((m) => m.includes(password))).toBe(false);

        const entries = buffer.query({ limit: 10000 }).entries;
        expect(entries.some((e) => e.message.includes(password))).toBe(false);
        expect(JSON.stringify(broadcasts)).not.toContain(password);
    });
});

describe('log buffer redaction', () => {
    it('redacts secrets written after a password/secret/token label', () => {
        expect(redactSecrets('Generated password for user "root": Abcdefgh23456789 — change it')).toBe(
            'Generated password for user "root": [REDACTED] — change it',
        );
        expect(redactSecrets('db password=hunter2 host=x')).toBe('db password=[REDACTED] host=x');
        expect(redactSecrets('token: "a b c"')).toBe('token: [REDACTED]');
        expect(redactSecrets('password changed for user joe')).toBe('password changed for user joe');
    });

    it('applies to every pushed entry, before it is stored or broadcast', () => {
        const buffer = new LogRingBuffer();
        const broadcasts: Record<string, unknown>[] = [];
        buffer.setBroadcastFn((msg) => broadcasts.push(msg));
        buffer.push({ timestamp: '', level: 'WARN', message: 'Generated password for user "root": S3cretS3cretS3cr now', source: 'console' });
        expect(buffer.query().entries[0].message).not.toContain('S3cretS3cretS3cr');
        expect(JSON.stringify(broadcasts)).not.toContain('S3cretS3cretS3cr');
    });
});
