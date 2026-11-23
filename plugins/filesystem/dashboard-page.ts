import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';

/** The admin dashboard's Filesystem page: `@qodalis/cli-dashboard-module-filesystem`, served at `/qcli/modules/filesystem`. */
export const FILESYSTEM_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'filesystem',
    title: 'Filesystem',
    titles: {
        es: 'Archivos',
        fr: 'Fichiers',
        de: 'Dateien',
        pt: 'Arquivos',
        it: 'File',
        ja: 'ファイル',
        ko: '파일',
        zh: '文件',
        ru: 'Файлы',
        ro: 'Fișiere',
    },
    icon: '📁',
    group: 'data',
    order: 10,
    permission: 'files:read',
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-filesystem`. `false` or no build leaves it out.
 */
export function filesystemDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-filesystem', require), FILESYSTEM_DASHBOARD_MODULE);
}
