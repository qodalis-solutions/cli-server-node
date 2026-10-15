/**
 * Client IP behind reverse proxies: `trustProxy` is a hop count (`true` = 1).
 * The client IP is the X-Forwarded-For entry appended by the outermost trusted
 * proxy (index len - n), never a client-controlled leftmost entry.
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { clientAddress } from '../auth/cli-server-auth';
import { clientIp } from '../../plugins/users/security';

function fakeReq(xff?: string | string[], remoteAddress = '127.0.0.1') {
    return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } };
}

const implementations: [string, (req: ReturnType<typeof fakeReq>, trust: boolean | number) => string][] = [
    ['server clientAddress', (req, trust) => clientAddress(req, trust)],
    ['users plugin clientIp', (req, trust) => clientIp(req as unknown as Request, trust)],
];

describe.each(implementations)('%s', (_name, ip) => {
    it('ignores X-Forwarded-For without trustProxy (false / 0)', () => {
        expect(ip(fakeReq('1.1.1.1'), false)).toBe('127.0.0.1');
        expect(ip(fakeReq('1.1.1.1'), 0)).toBe('127.0.0.1');
    });

    it('true trusts one hop: the rightmost entry, not the spoofable leftmost', () => {
        expect(ip(fakeReq('6.6.6.6, 2.2.2.2'), true)).toBe('2.2.2.2');
        expect(ip(fakeReq('6.6.6.6,2.2.2.2'), 1)).toBe('2.2.2.2');
        expect(ip(fakeReq('2.2.2.2'), true)).toBe('2.2.2.2');
    });

    it('a number n trusts n hops: entry at index len - n', () => {
        expect(ip(fakeReq('6.6.6.6, 2.2.2.2, 10.0.0.5'), 2)).toBe('2.2.2.2');
        expect(ip(fakeReq('6.6.6.6, 2.2.2.2, 10.0.0.5'), 3)).toBe('6.6.6.6');
    });

    it('fewer entries than hops: the leftmost entry', () => {
        expect(ip(fakeReq('2.2.2.2, 10.0.0.5'), 5)).toBe('2.2.2.2');
    });

    it('absent or empty header: the socket address', () => {
        expect(ip(fakeReq(undefined), true)).toBe('127.0.0.1');
        expect(ip(fakeReq(''), 2)).toBe('127.0.0.1');
        expect(ip(fakeReq('  '), 1)).toBe('127.0.0.1');
    });

    it('an empty selected entry falls back to the socket address', () => {
        expect(ip(fakeReq('6.6.6.6, '), 1)).toBe('127.0.0.1');
        expect(ip(fakeReq('6.6.6.6, , 10.0.0.5'), 2)).toBe('127.0.0.1');
    });

    it('a hop count below 1 other than 0 counts as 1', () => {
        expect(ip(fakeReq('6.6.6.6, 2.2.2.2'), -1)).toBe('2.2.2.2');
        expect(ip(fakeReq('6.6.6.6, 2.2.2.2'), 0.5)).toBe('2.2.2.2');
    });

    it('repeated header lines are treated as one list', () => {
        expect(ip(fakeReq(['6.6.6.6', '2.2.2.2']), 1)).toBe('2.2.2.2');
    });
});
