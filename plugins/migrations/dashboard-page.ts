import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import express, { type Router } from 'express';
import type { CliDashboardExtension } from '@qodalis/cli-server-abstractions';
import { MigrationsPermissions } from './controller';

/** Where the dashboard loads the migrations page from (outside the API, so its `import()` needs no token). */
export const MIGRATIONS_DASHBOARD_PREFIX = '/qcli/migrations';

/** The page's title in the dashboard's languages. */
const TITLES: Record<string, string> = {
    es: 'Migraciones',
    fr: 'Migrations',
    de: 'Migrationen',
    pt: 'Migrações',
    it: 'Migrazioni',
    ja: 'マイグレーション',
    ko: '마이그레이션',
    zh: '迁移',
    ru: 'Миграции',
    ro: 'Migrări',
};

/**
 * The build of `@qodalis/cli-dashboard-module-migrations`: copied next to the plugin (`npm run copy-dashboard`),
 * else the installed package. Undefined when neither is there (the dashboard then shows no migrations page).
 */
export function findMigrationsPage(dir?: string): string | undefined {
    const candidates = dir
        ? [dir]
        : [path.join(__dirname, 'dashboard'), path.join(__dirname, '..', 'dashboard')];
    if (!dir) {
        try {
            candidates.push(path.join(path.dirname(require.resolve('@qodalis/cli-dashboard-module-migrations/package.json')), 'dist'));
        } catch {
            // Not installed
        }
    }
    return candidates.find((d) => fs.existsSync(path.join(d, 'extension.js')));
}

/** The static files and the dashboard extension of the migrations page in `dir`. */
export function migrationsPage(dir: string): { router: Router; extension: CliDashboardExtension } {
    const version = (file: string) => {
        const full = path.join(dir, file);
        return fs.existsSync(full) ? createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 12) : undefined;
    };
    const js = version('extension.js');
    const css = version('extension.css');
    const router = express.Router();
    // The URLs carry the content's hash (?v=), so a new build is fetched at once
    router.use(express.static(dir, { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
    return {
        router,
        extension: {
            id: 'migrations',
            title: 'Migrations',
            titles: TITLES,
            icon: '🗄️',
            group: 'data',
            order: 20,
            permission: MigrationsPermissions.Read,
            entry: `${MIGRATIONS_DASHBOARD_PREFIX}/extension.js?v=${js}`,
            ...(css ? { styles: [`${MIGRATIONS_DASHBOARD_PREFIX}/extension.css?v=${css}`] } : {}),
        },
    };
}
