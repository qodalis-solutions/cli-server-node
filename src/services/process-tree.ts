import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

/** One row of the process table. `sid` is only known on Linux. */
interface ProcessEntry {
    pid: number;
    ppid: number;
    pgid: number;
    sid?: number;
}

/** Delay between SIGHUP/SIGTERM and the final SIGKILL. */
export const PROCESS_TREE_KILL_GRACE_MS = 1000;

/** Linux: `/proc/<pid>/stat` (no `ps` needed, works in slim containers). */
function readProcTable(): ProcessEntry[] {
    const entries: ProcessEntry[] = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
            // "pid (comm) state ppid pgrp session ..." — comm may contain spaces and parentheses
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            entries.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]) });
        } catch {
            // exited while listing
        }
    }
    return entries;
}

/** macOS / BSD: `ps -A -o pid=,ppid=,pgid=`. */
function readPsTable(): ProcessEntry[] {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 });
    const entries: ProcessEntry[] = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) entries.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
    }
    return entries;
}

function readProcessTable(): ProcessEntry[] {
    try {
        return os.platform() === 'linux' && fs.existsSync('/proc/self/stat') ? readProcTable() : readPsTable();
    } catch {
        return [];
    }
}

/** `seeds` (except `rootPid`) and all their descendants, by parent PID. */
function descendants(table: ProcessEntry[], rootPid: number, seeds: number[]): Set<number> {
    const children = new Map<number, number[]>();
    for (const p of table) {
        const list = children.get(p.ppid);
        if (list) list.push(p.pid);
        else children.set(p.ppid, [p.pid]);
    }
    const found = new Set<number>();
    const queue = [...seeds];
    while (queue.length) {
        const pid = queue.pop()!;
        if (pid !== rootPid) {
            if (found.has(pid)) continue;
            found.add(pid);
        }
        for (const child of children.get(pid) ?? []) {
            if (child !== rootPid && !found.has(child)) queue.push(child);
        }
    }
    found.delete(process.pid);
    return found;
}

function treeSeeds(table: ProcessEntry[], rootPid: number): number[] {
    const seeds = [rootPid];
    for (const p of table) {
        if (p.pgid === rootPid || p.sid === rootPid) seeds.push(p.pid);
    }
    return seeds;
}

/**
 * PIDs of everything a shell started: its process group, (Linux) its session,
 * and every descendant of those — including background jobs that interactive
 * shells move to their own process groups and `setsid`/`nohup` children.
 * Processes already re-parented to init (double fork before the shell closed)
 * cannot be found this way. Does not include `rootPid` itself.
 */
export function collectProcessTree(rootPid: number): number[] {
    const table = readProcessTable();
    return [...descendants(table, rootPid, treeSeeds(table, rootPid))];
}

function signal(pid: number, sig: NodeJS.Signals): void {
    try {
        process.kill(pid, sig);
    } catch {
        // already gone
    }
}

/**
 * Terminates a shell and everything it started (Unix): collects the tree first
 * (the shell's death re-parents its children), then sends SIGHUP and SIGTERM to
 * the shell's process group, the shell and every collected process, and SIGKILL
 * after `graceMs`. The final pass re-collects so that children forked meanwhile
 * by the collected processes die too.
 */
export function terminateProcessTree(rootPid: number, graceMs = PROCESS_TREE_KILL_GRACE_MS): void {
    const pids = collectProcessTree(rootPid);
    const send = (targets: Iterable<number>, sig: NodeJS.Signals) => {
        signal(-rootPid, sig);
        signal(rootPid, sig);
        for (const pid of targets) signal(pid, sig);
    };
    send(pids, 'SIGHUP');
    send(pids, 'SIGTERM');
    setTimeout(() => {
        const table = readProcessTable();
        const alive = new Set(table.map((p) => p.pid));
        const seeds = [...treeSeeds(table, rootPid), ...pids.filter((pid) => alive.has(pid))];
        send(descendants(table, rootPid, seeds), 'SIGKILL');
    }, graceMs);
}
