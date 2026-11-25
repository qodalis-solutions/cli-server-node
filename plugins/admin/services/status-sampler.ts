import { readSystemMemory } from './system-memory';

/** One sample of the server status (`GET /api/v1/qcli/status/history`). */
export interface StatusSample {
    /** ISO 8601 UTC time of the sample. */
    timestamp: string;
    /** Resident memory of the process in MB. */
    memoryMb: number;
    /** Memory in use on the machine (or in the container when limited) in MB; null when unknown. */
    systemMemoryUsedMb?: number | null;
    /** The RAM the server can use in MB (the container limit when one applies); null when unknown. */
    systemMemoryTotalMb?: number | null;
    /**
     * Process CPU over the last interval as a percentage of one core; null for the
     * first sample or when the platform cannot tell.
     */
    cpuPercent: number | null;
    activeWsConnections: number;
    activeShellSessions: number;
}

/** The live values a sample reads. */
export interface StatusSampleSource {
    getActiveWsConnections: () => number;
    getActiveShellSessions: () => number;
}

/** Seconds between two samples. */
export const STATUS_SAMPLE_INTERVAL_SECONDS = 15;

/** Samples kept: 24 hours at one sample every 15 seconds. */
export const STATUS_HISTORY_CAPACITY = 5760;

/** The resident memory of the process in MB, as `GET /status` reports it. */
export function processMemoryMb(): number {
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
}

/**
 * Samples the server status every 15 seconds (the first at {@link start}) into a
 * ring buffer of the last 24 hours, in memory. The timer is unref'd, so it never
 * keeps the process alive; {@link stop} clears it.
 */
export class StatusSampler {
    private readonly _samples: (StatusSample | undefined)[];
    private _head = 0;
    private _count = 0;
    private _timer?: ReturnType<typeof setInterval>;
    private _lastCpu?: NodeJS.CpuUsage;
    private _lastWall?: bigint;

    constructor(
        private readonly _source: StatusSampleSource,
        readonly capacity = STATUS_HISTORY_CAPACITY,
        readonly intervalSeconds = STATUS_SAMPLE_INTERVAL_SECONDS,
    ) {
        this._samples = new Array(capacity);
    }

    /** Takes the first sample and starts the timer (no-op when started). */
    start(): void {
        if (this._timer) return;
        this.sample();
        this._timer = setInterval(() => this.sample(), this.intervalSeconds * 1000);
        this._timer.unref?.();
    }

    /** Stops sampling; the samples taken stay. */
    stop(): void {
        if (this._timer) clearInterval(this._timer);
        this._timer = undefined;
    }

    /** Takes one sample now and adds it to the history. */
    sample(now = new Date()): StatusSample {
        const system = readSystemMemory();
        const sample: StatusSample = {
            timestamp: now.toISOString(),
            memoryMb: processMemoryMb(),
            systemMemoryUsedMb: system.systemMemoryUsedMb,
            systemMemoryTotalMb: system.systemMemoryTotalMb,
            cpuPercent: this.cpuPercent(),
            activeWsConnections: this._source.getActiveWsConnections(),
            activeShellSessions: this._source.getActiveShellSessions(),
        };
        this.add(sample);
        return sample;
    }

    /** Adds a sample, dropping the oldest when full. */
    add(sample: StatusSample): void {
        this._samples[this._head] = sample;
        this._head = (this._head + 1) % this.capacity;
        if (this._count < this.capacity) this._count++;
    }

    /** The latest sample, if any. */
    get latest(): StatusSample | undefined {
        return this._count === 0 ? undefined : this._samples[(this._head - 1 + this.capacity) % this.capacity];
    }

    /** The samples of the last `minutes` minutes, oldest first. */
    history(minutes: number, now = Date.now()): StatusSample[] {
        const cutoff = now - minutes * 60_000;
        const out: StatusSample[] = [];
        const start = (this._head - this._count + this.capacity) % this.capacity;
        for (let i = 0; i < this._count; i++) {
            const sample = this._samples[(start + i) % this.capacity]!;
            if (new Date(sample.timestamp).getTime() >= cutoff) out.push(sample);
        }
        return out;
    }

    /** Process CPU time since the previous sample per wall time, in % of one core. */
    private cpuPercent(): number | null {
        let cpu: NodeJS.CpuUsage;
        let wall: bigint;
        try {
            cpu = process.cpuUsage();
            wall = process.hrtime.bigint();
        } catch {
            return null;
        }
        const lastCpu = this._lastCpu;
        const lastWall = this._lastWall;
        this._lastCpu = cpu;
        this._lastWall = wall;
        if (!lastCpu || lastWall === undefined) return null;
        const wallMicros = Number(wall - lastWall) / 1000;
        if (wallMicros <= 0) return null;
        const cpuMicros = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
        return Math.round((cpuMicros / wallMicros) * 100 * 10) / 10;
    }
}

/** Smallest, average and largest of a series (average rounded to 0.01, as memory is). */
export interface StatusRange {
    min: number;
    avg: number;
    max: number;
}

/** A summary of status samples (`admin status --history`). */
export interface StatusHistorySummary {
    count: number;
    /** First and last sample time; absent without samples. */
    from?: string;
    to?: string;
    memoryMb?: StatusRange;
    /** Over the samples that have a CPU value; absent when none has. */
    cpuPercent?: StatusRange;
    /** Largest number of WebSocket connections and shell sessions seen. */
    maxWsConnections: number;
    maxShellSessions: number;
}

function range(values: number[]): StatusRange | undefined {
    if (values.length === 0) return undefined;
    const sum = values.reduce((a, b) => a + b, 0);
    return { min: Math.min(...values), avg: Math.round((sum / values.length) * 100) / 100, max: Math.max(...values) };
}

/** Count, time span, min/avg/max memory and CPU, and the peak connections of the samples. */
export function summarizeStatusHistory(samples: readonly StatusSample[]): StatusHistorySummary {
    const memory = range(samples.map((s) => s.memoryMb));
    const cpu = range(samples.map((s) => s.cpuPercent).filter((c): c is number => typeof c === 'number'));
    return {
        count: samples.length,
        ...(samples.length ? { from: samples[0].timestamp, to: samples[samples.length - 1].timestamp } : {}),
        ...(memory ? { memoryMb: memory } : {}),
        ...(cpu ? { cpuPercent: cpu } : {}),
        maxWsConnections: samples.reduce((m, s) => Math.max(m, s.activeWsConnections), 0),
        maxShellSessions: samples.reduce((m, s) => Math.max(m, s.activeShellSessions), 0),
    };
}
