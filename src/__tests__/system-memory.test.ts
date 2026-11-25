/**
 * The machine's (or container's) memory of the admin status: installed RAM and available memory, a container limit
 * below the installed RAM with the cgroup's usage, null for what cannot be read, and the `admin status` Memory line.
 */
import { describe, it, expect } from 'vitest';
import { formatMemoryLine, formatMemorySize, readSystemMemory, SystemMemoryReaders } from '../../plugins/admin/index';

const MB = 1024 * 1024;
const GB = 1024 * MB;

function readers(overrides: Partial<SystemMemoryReaders>): SystemMemoryReaders {
    return {
        totalBytes: () => 16 * GB,
        availableBytes: () => 6 * GB,
        limitBytes: () => 0,
        cgroupUsageBytes: () => undefined,
        ...overrides,
    };
}

describe('readSystemMemory', () => {
    it('without a limit: the installed RAM and the machine use (total minus available)', () => {
        expect(readSystemMemory(readers({}))).toEqual({ systemMemoryTotalMb: 16384, systemMemoryUsedMb: 10240, memoryLimited: false });
    });

    it('a container limit below the installed RAM: the limit and the cgroup usage', () => {
        const memory = readSystemMemory(readers({ limitBytes: () => 512 * MB, cgroupUsageBytes: () => 300 * MB }));
        expect(memory).toEqual({ systemMemoryTotalMb: 512, systemMemoryUsedMb: 300, memoryLimited: true });
    });

    it('a limit at or above the installed RAM (or the "no limit" huge value) is not a limit', () => {
        expect(readSystemMemory(readers({ limitBytes: () => 16 * GB })).memoryLimited).toBe(false);
        expect(readSystemMemory(readers({ limitBytes: () => Number.MAX_SAFE_INTEGER })).systemMemoryTotalMb).toBe(16384);
    });

    it('limited without a readable cgroup usage: used is null, not the machine use', () => {
        expect(readSystemMemory(readers({ limitBytes: () => 512 * MB }))).toEqual({ systemMemoryTotalMb: 512, systemMemoryUsedMb: null, memoryLimited: true });
    });

    it('null for what cannot be read; readers that throw never make it throw', () => {
        const boom = () => {
            throw new Error('boom');
        };
        expect(readSystemMemory({ totalBytes: boom, availableBytes: boom, limitBytes: boom, cgroupUsageBytes: boom })).toEqual({
            systemMemoryTotalMb: null,
            systemMemoryUsedMb: null,
            memoryLimited: null,
        });
        expect(readSystemMemory(readers({ availableBytes: boom }))).toEqual({ systemMemoryTotalMb: 16384, systemMemoryUsedMb: null, memoryLimited: false });
        expect(readSystemMemory(readers({ totalBytes: () => NaN })).systemMemoryTotalMb).toBeNull();
    });

    it('reads this machine with the default readers', () => {
        const memory = readSystemMemory();
        expect(memory.systemMemoryTotalMb).toBeGreaterThan(0);
        expect(typeof memory.memoryLimited).toBe('boolean');
    });
});

describe('formatMemoryLine', () => {
    const line = (systemMemoryTotalMb: number | null, systemMemoryUsedMb: number | null, memoryLimited: boolean | null) =>
        formatMemoryLine({ memoryUsageMb: 146, systemMemoryTotalMb, systemMemoryUsedMb, memoryLimited });

    it('the process, then the machine or container use', () => {
        expect(line(16384, 10035, false)).toBe('146 MB (process) · machine 9.8 GB of 16 GB used (61%)');
        expect(line(512, 300, true)).toBe('146 MB (process) · container 300 MB of 512 MB used (59%)');
    });

    it('the total alone without the use; the process alone without the total', () => {
        expect(line(16384, null, false)).toBe('146 MB (process) · machine 16 GB');
        expect(line(512, null, true)).toBe('146 MB (process) · container limit 512 MB');
        expect(line(null, null, null)).toBe('146 MB');
    });

    it('sizes: MB below 1 GB, GB with one decimal from 1 GB', () => {
        expect(formatMemorySize(1023)).toBe('1023 MB');
        expect(formatMemorySize(1024)).toBe('1 GB');
        expect(formatMemorySize(1536)).toBe('1.5 GB');
    });
});
