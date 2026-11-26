/**
 * Writes the `qodalis` block of every plugin with an entry point from the entry itself: `entry`, `order` (when the
 * entry exports one) and `config` (its `settings` as `cliPluginConfigManifest` makes them: what the marketplace shows
 * before install, `needsConfiguration` for a required setting without a default). `npm run sync:plugin-config`;
 * `src/__tests__/plugin-config-manifest.test.ts` fails when a package.json is behind its entry.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cliPluginConfigManifest, type CliConfigSettingDefinition } from '@qodalis/cli-server-abstractions';

const root = join(__dirname, '..', 'plugins');
const KEY_ORDER = ['kind', 'plugin', 'entry', 'order', 'autoInstall', 'autoInstallReason', 'title', 'icon', 'platforms', 'config'];

/** The `qodalis` block a package should have, from its entry module. */
export function expectedQodalisBlock(current: Record<string, unknown>, entry: { settings?: CliConfigSettingDefinition[]; order?: number }): Record<string, unknown> {
    const next: Record<string, unknown> = { ...current };
    delete next.autoInstall;
    delete next.autoInstallReason;
    if (typeof entry.order === 'number') next.order = entry.order;
    else delete next.order;
    const config = cliPluginConfigManifest(entry.settings ?? []);
    if (config.entries.length > 0) next.config = config;
    else delete next.config;
    const ordered: Record<string, unknown> = {};
    for (const key of [...KEY_ORDER, ...Object.keys(next)]) if (key in next && !(key in ordered)) ordered[key] = next[key];
    return ordered;
}

/** The file with only its `qodalis` block rewritten (the rest keeps its formatting). */
function replaceQodalisBlock(text: string, block: unknown): string {
    const start = text.indexOf('"qodalis": {');
    if (start < 0) throw new Error('no qodalis block');
    let depth = 0;
    let end = -1;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) {
            end = i + 1;
            break;
        }
    }
    const indent = /^([ \t]*)/.exec(text.slice(text.lastIndexOf('\n', start) + 1))?.[1] ?? '    ';
    const json = JSON.stringify(block, null, 4).replace(/\n/g, `\n${indent}`);
    return `${text.slice(0, start)}"qodalis": ${json}${text.slice(end)}`;
}

async function main(): Promise<void> {
    for (const name of readdirSync(root).sort()) {
        const file = join(root, name, 'package.json');
        if (!existsSync(file)) continue;
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        const entryTs = ['plugin.ts', 'src/plugin.ts'].map((f) => join(root, name, f)).find(existsSync);
        if (!pkg.qodalis || !entryTs || pkg.qodalis.autoInstall === false && name === 'admin') continue;
        const entry = await import(entryTs);
        pkg.qodalis = expectedQodalisBlock({ entry: './dist/plugin.js', ...pkg.qodalis }, entry);
        writeFileSync(file, replaceQodalisBlock(readFileSync(file, 'utf8'), pkg.qodalis));
        console.log(`${name}: ${pkg.qodalis.config ? pkg.qodalis.config.entries.length : 0} settings${pkg.qodalis.config?.needsConfiguration ? ', needs configuration' : ''}`);
    }
}

if (typeof require !== 'undefined' && require.main === module) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
