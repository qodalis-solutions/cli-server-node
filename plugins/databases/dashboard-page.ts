import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';
import { DatabasesPermissions } from './controller';

/** Where the dashboard loads the databases page from (outside the API, so its `import()` needs no token). */
export const DATABASES_DASHBOARD_PREFIX = '/qcli/databases';

/** The admin dashboard's Databases page and its Overview cards (`@qodalis/cli-dashboard-module-databases`). */
export const DATABASES_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'databases',
    title: 'Databases',
    titles: {
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
    },
    icon: '🗄️',
    group: 'data',
    order: 20,
    permission: DatabasesPermissions.Read,
    widgets: ['overview'],
};

/**
 * The page from its build: `dir`, else the copy next to the plugin (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-databases`. `false` or no build leaves it out.
 */
export function databasesDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(
        dir,
        () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-databases', require),
        DATABASES_DASHBOARD_MODULE,
        DATABASES_DASHBOARD_PREFIX,
    );
}
