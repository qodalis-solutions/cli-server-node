import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

/** A markdown page as the docs plugin serves it. */
export interface DocsPage {
    slug: string;
    title: string;
    group: string;
    order: number;
    /** The body, front matter removed; `{{ variables }}` are replaced per request. */
    markdown: string;
}

export const DEFAULT_DOCS_GROUP = 'Guides';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** Larger page files are skipped (logged). */
export const MAX_PAGE_BYTES = 1024 * 1024;
const INTEGER = /^[+-]?\d+$/;

/** True for a page slug: lower-case letters, digits and `-`, not starting with `-`. */
export function isValidSlug(slug: unknown): slug is string {
    return typeof slug === 'string' && SLUG.test(slug);
}

/** A front matter value wrapped in matching `"…"` or `'…'` is unwrapped. */
function unquote(value: string): string {
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
        return value.slice(1, -1);
    }
    return value;
}

/**
 * Parses a page: front matter only when the first line is exactly `---`, ending at the next
 * line that is exactly `---` (without one the whole text is the body). Lines `key: value`
 * with the keys `title`, `group`, `order` (others ignored). Defaults: the title of the first
 * `# ` line of the body, else the slug; group `Guides`; order 0.
 */
export function parsePage(slug: string, text: string): DocsPage {
    const source = text.replace(/^﻿/, '');
    const lines = source.split('\n');
    // Front matter lines ignore a trailing `\r` (CRLF files); the body is kept as written
    const bare = lines.map((line) => line.replace(/\r$/, ''));
    const front: Record<string, string> = {};
    let markdown = source;
    if (bare[0] === '---') {
        const end = bare.indexOf('---', 1);
        if (end > 0) {
            for (const line of bare.slice(1, end)) {
                const colon = line.indexOf(':');
                if (colon <= 0) continue;
                const key = line.slice(0, colon).trim();
                if (key === 'title' || key === 'group' || key === 'order') {
                    front[key] = unquote(line.slice(colon + 1).trim());
                }
            }
            markdown = lines.slice(end + 1).join('\n');
        }
    }
    let order = 0;
    if (front.order !== undefined) {
        if (!INTEGER.test(front.order)) {
            throw new Error(`invalid order in docs page: ${slug}`);
        }
        order = Number.parseInt(front.order, 10);
    }
    const heading = markdown
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .find((line) => line.startsWith('# '));
    return {
        slug,
        title: front.title || (heading ? heading.slice(2).trim() : '') || slug,
        group: front.group || DEFAULT_DOCS_GROUP,
        order,
        markdown,
    };
}

/**
 * The pages of a folder (relative to the working directory): every `*.md` file directly in
 * it, names starting with `.` or `_`, symbolic links and files over 1 MB skipped; the slug
 * is the file name without `.md`, lower-cased.
 */
export function readFolder(folder: string): DocsPage[] {
    const dir = resolve(folder);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`docs folder not found: ${folder}`);
    }
    const pages: DocsPage[] = [];
    for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith('.md') || name.startsWith('.') || name.startsWith('_')) continue;
        const file = join(dir, name);
        // regular files only: symbolic links (which could point outside the folder) are skipped
        const stat = lstatSync(file);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_PAGE_BYTES) {
            console.warn(`[docs] ${name} is larger than 1 MB and is skipped`);
            continue;
        }
        const slug = name.slice(0, -'.md'.length).toLowerCase();
        if (!isValidSlug(slug)) {
            throw new Error(`invalid docs page name: ${name}`);
        }
        pages.push(parsePage(slug, readFileSync(file, 'utf8')));
    }
    return pages;
}

const upper = (s: string) => s.toUpperCase();

/** Page order: `order` ascending, then `title` (ordinal, case-insensitive), then `slug`. */
export function comparePages(a: DocsPage, b: DocsPage): number {
    if (a.order !== b.order) return a.order - b.order;
    const ta = upper(a.title);
    const tb = upper(b.title);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** `{{ key }}` placeholders; unknown keys are left as written. */
export const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;
export const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9_.-]*$/;

export function replaceVariables(text: string, variables: ReadonlyMap<string, string>): string {
    return text.replace(VARIABLE, (match, key: string) => variables.get(key) ?? match);
}
