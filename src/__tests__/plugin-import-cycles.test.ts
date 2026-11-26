/**
 * Plugin entry points load on their own: no plugin's entry (`plugin.ts`) is part of an import cycle (the weather entry
 * and its index imported each other, and a setting read at load time crashed the demo under tsx/CJS), and every
 * built package's index and entry load first in a fresh CommonJS process.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';

const PLUGINS = resolve(__dirname, '..', '..', 'plugins');

/** The plugins with an entry: their name and the entry file. */
const entries = readdirSync(PLUGINS)
    .map((name) => ({ name, entry: ['plugin.ts', 'src/plugin.ts'].map((f) => join(PLUGINS, name, f)).find(existsSync) }))
    .filter((p): p is { name: string; entry: string } => !!p.entry);

/** The files a source imports from its own package (relative imports, type-only ones left out). */
function localImports(file: string): string[] {
    const text = readFileSync(file, 'utf8');
    const result: string[] = [];
    const pattern = /^\s*(import|export)\s+(type\s+)?[^'";]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
    for (const m of text.matchAll(pattern)) {
        if (m[2]) continue;
        const base = resolve(dirname(file), m[3]);
        const target = [`${base}.ts`, join(base, 'index.ts')].find((f) => existsSync(f) && statSync(f).isFile());
        if (target) result.push(target);
    }
    return result;
}

/** A cycle through `start` (the files, start first), or undefined. */
function cycleThrough(start: string): string[] | undefined {
    const seen = new Set<string>();
    const walk = (file: string, path: string[]): string[] | undefined => {
        for (const next of localImports(file)) {
            if (next === start) return [...path, next];
            if (seen.has(next)) continue;
            seen.add(next);
            const found = walk(next, [...path, next]);
            if (found) return found;
        }
        return undefined;
    };
    return walk(start, [start]);
}

describe('plugin entry points', () => {
    it.each(entries)('$name: the entry is in no import cycle', ({ entry }) => {
        const cycle = cycleThrough(entry);
        expect(cycle?.map((f) => f.slice(PLUGINS.length + 1)), 'import cycle').toBeUndefined();
    });

    it('every built index, then its entry, loads first in a fresh CommonJS process', () => {
        const failures: string[] = [];
        for (const { name } of entries) {
            const pkg = JSON.parse(readFileSync(join(PLUGINS, name, 'package.json'), 'utf8'));
            const main = join(PLUGINS, name, pkg.main ?? 'dist/index.js');
            const entry = join(PLUGINS, name, pkg.qodalis.entry);
            if (!existsSync(main) || !existsSync(entry)) continue; // not built
            for (const order of [[main, entry], [entry, main]]) {
                const script = `for (const f of ${JSON.stringify(order)}) { const m = require(f); if (!m) throw new Error('empty ' + f); }
                    const e = require(${JSON.stringify(entry)}); if (typeof e.createPlugin !== 'function' || !e.plugin || !Array.isArray(e.settings)) throw new Error('incomplete entry');`;
                const run = spawnSync(process.execPath, ['-e', script], { cwd: join(PLUGINS, name), encoding: 'utf8', timeout: 30_000 });
                const output = run.stderr || run.stdout;
                // A dependency not installed next to this checkout is not a load-order failure
                if (run.status !== 0 && /Cannot find module '(?!\.)/.test(output)) continue;
                if (run.status !== 0) failures.push(`${name} (${order.map((f) => f.split('/').pop()).join(' then ')}): ${output.split('\n').find((l) => /Error/.test(l)) ?? run.status}`);
            }
        }
        expect(failures).toEqual([]);
    }, 120_000);
});
