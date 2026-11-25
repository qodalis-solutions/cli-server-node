import * as fs from 'fs';
import * as os from 'os';

/** The machine's (or container's) memory, as `GET /status` reports it. Every field is null when unknown. */
export interface SystemMemory {
    /** The RAM the server can use in MB: the container limit when one is set below the installed RAM, else the installed RAM. */
    systemMemoryTotalMb: number | null;
    /** The memory in use in MB: the container's usage when limited, else the machine's (total minus available). */
    systemMemoryUsedMb: number | null;
    /** True when the total is a container (cgroup) limit. */
    memoryLimited: boolean | null;
}

/** Where {@link readSystemMemory} reads from, in bytes; injectable for tests. Any reader may throw or return undefined. */
export interface SystemMemoryReaders {
    /** Installed RAM (`os.totalmem()`). */
    totalBytes: () => number | undefined;
    /** Available RAM of the machine (`os.freemem()`). */
    availableBytes: () => number | undefined;
    /** The container limit (`process.constrainedMemory()`): 0, undefined or a huge number without one. */
    limitBytes: () => number | undefined;
    /** The container's usage (cgroup v2 `memory.current`, v1 `memory.usage_in_bytes`). */
    cgroupUsageBytes: () => number | undefined;
}

const CGROUP_USAGE_FILES = ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'];

function readCgroupUsage(): number | undefined {
    for (const file of CGROUP_USAGE_FILES) {
        try {
            const value = Number(fs.readFileSync(file, 'utf8').trim());
            if (Number.isFinite(value) && value > 0) return value;
        } catch {
            // not there: next file
        }
    }
    return undefined;
}

/** The readers of this process: `os`, `process.constrainedMemory()` and the cgroup files. */
export const defaultSystemMemoryReaders: SystemMemoryReaders = {
    totalBytes: () => os.totalmem(),
    availableBytes: () => os.freemem(),
    limitBytes: () => (typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : undefined),
    cgroupUsageBytes: readCgroupUsage,
};

function safe(read: () => number | undefined): number | undefined {
    try {
        const value = read();
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** The memory the server can use and the memory in use; never throws (unknown values are null). */
export function readSystemMemory(readers: SystemMemoryReaders = defaultSystemMemoryReaders): SystemMemory {
    const installed = safe(readers.totalBytes);
    const limit = safe(readers.limitBytes);
    const limited = limit !== undefined && installed !== undefined && limit < installed;
    const total = limited ? limit : installed;
    if (total === undefined) return { systemMemoryTotalMb: null, systemMemoryUsedMb: null, memoryLimited: null };

    let used: number | undefined;
    if (limited) {
        used = safe(readers.cgroupUsageBytes);
    } else {
        const available = safe(readers.availableBytes);
        if (available !== undefined && available <= total) used = total - available;
    }
    return {
        systemMemoryTotalMb: toMb(total),
        systemMemoryUsedMb: used === undefined ? null : Math.min(toMb(used), toMb(total)),
        memoryLimited: limited,
    };
}
