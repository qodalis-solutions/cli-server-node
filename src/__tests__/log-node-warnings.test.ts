/**
 * Node's own process warnings (deprecations, experimental features) reach the admin log through console.error; they
 * are warnings, not errors, so they do not show under the Overview's "Needs attention".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogRingBuffer, isNodeWarning } from '../../plugins/admin/index';

describe('isNodeWarning', () => {
    it('recognises the warnings Node prints itself', () => {
        expect(isNodeWarning('(node:74015) [DEP0205] DeprecationWarning: `module.register()` is deprecated.')).toBe(true);
        expect(isNodeWarning('(node:12) ExperimentalWarning: SQLite is an experimental feature')).toBe(true);
        expect(isNodeWarning('(node:12) Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to 0')).toBe(true);
    });

    it('leaves other errors alone', () => {
        expect(isNodeWarning('Error: connect ECONNREFUSED 127.0.0.1:5432')).toBe(false);
        expect(isNodeWarning('database failed (node:12) DeprecationWarning: quoted')).toBe(false);
        expect(isNodeWarning('(node:abc) DeprecationWarning: x')).toBe(false);
    });
});

describe('LogRingBuffer console capture', () => {
    let buffer: LogRingBuffer | undefined;
    afterEach(() => {
        buffer?.restoreConsole();
        vi.restoreAllMocks();
    });

    it('files a Node warning written to console.error as WARN from node, and other errors as ERROR', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        buffer = new LogRingBuffer();
        buffer.interceptConsole();

        console.error('(node:1) [DEP0205] DeprecationWarning: `module.register()` is deprecated.');
        console.error('Error: disk full');

        const entries = buffer.query({}).entries;
        const warning = entries.find(e => e.message.includes('DEP0205'))!;
        const error = entries.find(e => e.message === 'Error: disk full')!;
        expect(warning.level).toBe('WARN');
        expect(warning.source).toBe('node');
        expect(error.level).toBe('ERROR');
        expect(error.source).toBe('console');
    });
});
