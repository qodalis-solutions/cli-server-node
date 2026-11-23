import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';

/** The admin dashboard's Data explorer page: `@qodalis/cli-dashboard-module-data-explorer`, served at `/qcli/modules/data-explorer`. */
export const DATA_EXPLORER_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'data-explorer',
    title: 'Data explorer',
    titles: {
        es: 'Explorador de datos',
        fr: 'Explorateur de données',
        de: 'Daten-Explorer',
        pt: 'Explorador de dados',
        it: 'Esplora dati',
        ja: 'データエクスプローラー',
        ko: '데이터 탐색기',
        zh: '数据浏览器',
        ru: 'Обозреватель данных',
        ro: 'Explorator de date',
    },
    icon: '⛁',
    group: 'data',
    order: 15,
    permission: 'data:query',
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-data-explorer`. `false` or no build leaves it out.
 */
export function dataExplorerDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-data-explorer', require), DATA_EXPLORER_DASHBOARD_MODULE);
}
