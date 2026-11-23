import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';

/** The admin dashboard's Audit page: `@qodalis/cli-dashboard-module-audit`, served at `/qcli/modules/audit`. */
export const AUDIT_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'audit',
    title: 'Audit',
    titles: {
        es: 'Auditoría',
        fr: 'Audit',
        de: 'Audit',
        pt: 'Auditoria',
        it: 'Audit',
        ja: '監査',
        ko: '감사',
        zh: '审计',
        ru: 'Аудит',
        ro: 'Audit',
    },
    icon: '🛡',
    group: 'operations',
    order: 30,
    permission: 'audit:read',
    search: '/?q=',
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-audit`. `false` or no build leaves it out.
 */
export function auditDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-audit', require), AUDIT_DASHBOARD_MODULE);
}
