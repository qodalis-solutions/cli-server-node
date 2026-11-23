import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import express, { type Router } from 'express';
import type { CliDashboardExtension } from '@qodalis/cli-server-abstractions';
import { DatabasesPermissions } from './controller';

/** Where the dashboard loads the databases page from (outside the API, so its `import()` needs no token). */
export const DATABASES_DASHBOARD_PREFIX = '/qcli/databases';

/** The page's title in the dashboard's languages. */
const TITLES: Record<string, string> = {
    es: 'Bases de datos',
    fr: 'Bases de données',
    de: 'Datenbanken',
    pt: 'Bancos de dados',
    it: 'Database',
    ja: 'データベース',
    ko: '데이터베이스',
    zh: '数据库',
    ru: 'Базы данных',
    ro: 'Baze de date',
};

/**
 * The build of `@qodalis/cli-dashboard-module-databases`: copied next to the plugin (`npm run copy-dashboard`),
 * else the installed package. Undefined when neither is there (the dashboard then shows no databases page).
 */
export function findDatabasesPage(dir?: string): string | undefined {
    const candidates = dir
        ? [dir]
        : [path.join(__dirname, 'dashboard'), path.join(__dirname, '..', 'dashboard')];
    if (!dir) {
        try {
            candidates.push(path.join(path.dirname(require.resolve('@qodalis/cli-dashboard-module-databases/package.json')), 'dist'));
        } catch {
            // Not installed
        }
    }
    return candidates.find((d) => fs.existsSync(path.join(d, 'extension.js')));
}

/** The static files and the dashboard extension of the databases page in `dir`. */
export function databasesPage(dir: string): { router: Router; extension: CliDashboardExtension } {
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
            id: 'databases',
            title: 'Databases',
            titles: TITLES,
            icon: '🗄️',
            group: 'data',
            order: 20,
            permission: DatabasesPermissions.Read,
            entry: `${DATABASES_DASHBOARD_PREFIX}/extension.js?v=${js}`,
            ...(css ? { styles: [`${DATABASES_DASHBOARD_PREFIX}/extension.css?v=${css}`] } : {}),
        },
    };
}
