import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
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

/**
 * Environment variable that tags every process a shell starts. Children inherit
 * it, so processes that escaped the tree (re-parented to init, new session) are
 * still found on cleanup unless they deliberately unset it.
 */
export const SHELL_ID_ENV = 'QCLI_SHELL_ID';

/** A fresh, unguessable shell marker value (128-bit hex). */
export function newShellId(): string {
    return randomBytes(16).toString('hex');
}

const SHELL_ID_RE = /^[0-9a-f]{32}$/;

/** Linux: does a NUL-separated `/proc/<pid>/environ` contain exactly `QCLI_SHELL_ID=<id>`? */
export function environHasShellId(environ: string, shellId: string): boolean {
    const wanted = `${SHELL_ID_ENV}=${shellId}`;
    return environ.split('\0').some((entry) => entry === wanted);
}

/**
 * macOS / BSD: does a `ps -E -o command=` line (command line followed by the
 * environment, space separated) contain `QCLI_SHELL_ID=<id>` as a whole token?
 */
export function psLineHasShellId(line: string, shellId: string): boolean {
    const wanted = ` ${SHELL_ID_ENV}=${shellId}`;
    let from = 0;
    for (;;) {
        const at = line.indexOf(wanted, from);
        if (at < 0) return false;
        const end = at + wanted.length;
        if (end === line.length || /\s/.test(line[end])) return true;
        from = at + 1;
    }
}

/** Linux: PIDs whose `/proc/<pid>/environ` carries the marker (unreadable entries are skipped). */
function markedFromProc(shellId: string): number[] {
    const found: number[] = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            if (environHasShellId(fs.readFileSync(`/proc/${name}/environ`, 'latin1'), shellId)) found.push(Number(name));
        } catch {
            // exited, or another user's process
        }
    }
    return found;
}

/** macOS / BSD: `ps -A -E -ww -o pid=,command=` shows the environment of the same user's processes. */
function markedFromPs(shellId: string): number[] {
    const out = execFileSync('ps', ['-A', '-E', '-ww', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024 * 1024,
    });
    const found: number[] = [];
    for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s/.exec(line);
        if (m && psLineHasShellId(line, shellId)) found.push(Number(m[1]));
    }
    return found;
}

/** PIDs of every process whose environment carries `QCLI_SHELL_ID=<shellId>`. */
export function findMarkedProcesses(shellId: string): number[] {
    if (!SHELL_ID_RE.test(shellId)) return [];
    try {
        return isProcLinux() ? markedFromProc(shellId) : markedFromPs(shellId);
    } catch {
        return [];
    }
}

function isProcLinux(): boolean {
    return os.platform() === 'linux' && fs.existsSync('/proc/self/stat');
}

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
        return isProcLinux() ? readProcTable() : readPsTable();
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
    const ownPgid = table.find((p) => p.pid === process.pid)?.pgid;
    if (ownPgid !== undefined) for (const p of table) if (p.pgid === ownPgid) found.delete(p.pid);
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
 * every descendant of those — including background jobs that interactive
 * shells move to their own process groups and `setsid`/`nohup` children — and,
 * when `shellId` is given, every process carrying the shell's
 * `QCLI_SHELL_ID` marker (and their descendants), which also catches processes
 * re-parented to init in a new session. Never includes `rootPid` itself, the
 * server process or the server's process group.
 */
export function collectProcessTree(rootPid: number, shellId?: string, extraSeeds: number[] = []): number[] {
    const table = readProcessTable();
    const marked = shellId ? findMarkedProcesses(shellId) : [];
    const alive = new Set(table.map((p) => p.pid));
    const seeds = [...treeSeeds(table, rootPid), ...marked, ...extraSeeds.filter((pid) => alive.has(pid))];
    return [...descendants(table, rootPid, seeds)];
}

function signal(pid: number, sig: NodeJS.Signals): void {
    try {
        process.kill(pid, sig);
    } catch {
        // already gone
    }
}

/**
 * Terminates a shell and everything it started (Unix): collects the targets
 * first (the shell's death re-parents its children), then sends SIGHUP and
 * SIGTERM to the shell's process group, the shell and every collected process,
 * and SIGKILL after `graceMs`. The final pass re-collects so that children
 * forked meanwhile by the collected processes die too.
 */
export function terminateProcessTree(rootPid: number, graceMs = PROCESS_TREE_KILL_GRACE_MS, shellId?: string): void {
    const pids = collectProcessTree(rootPid, shellId);
    const send = (targets: Iterable<number>, sig: NodeJS.Signals) => {
        if (rootPid !== process.pid) {
            signal(-rootPid, sig);
            signal(rootPid, sig);
        }
        for (const pid of targets) signal(pid, sig);
    };
    send(pids, 'SIGHUP');
    send(pids, 'SIGTERM');
    setTimeout(() => send(collectProcessTree(rootPid, shellId, pids), 'SIGKILL'), graceMs);
}
