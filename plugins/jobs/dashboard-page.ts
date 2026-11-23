import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';

/** The admin dashboard's Jobs page (with its Overview cards and command palette entries): `@qodalis/cli-dashboard-module-jobs`, served at `/qcli/modules/jobs`. */
export const JOBS_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'jobs',
    title: 'Jobs',
    titles: {
        es: 'Tareas',
        fr: 'Tâches',
        de: 'Jobs',
        pt: 'Tarefas',
        it: 'Job',
        ja: 'ジョブ',
        ko: '작업',
        zh: '任务',
        ru: 'Задания',
        ro: 'Joburi',
    },
    icon: '⏱',
    group: 'operations',
    order: 10,
    permission: 'jobs:read',
    widgets: ['overview', 'palette'],
    search: '/?q=',
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-jobs`. `false` or no build leaves it out.
 */
export function jobsDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-jobs', require), JOBS_DASHBOARD_MODULE);
}
