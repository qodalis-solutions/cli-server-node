import { CliDashboardModuleInfo, CliDashboardModulePage, findDashboardModule, resolveDashboardModulePage } from '@qodalis/cli-server-abstractions';

/** The admin dashboard's API tokens page (every user sees their own tokens): `@qodalis/cli-dashboard-module-tokens`, served at `/qcli/modules/tokens`. */
export const TOKENS_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'tokens',
    title: 'API tokens',
    titles: {
        es: 'Tokens de API',
        fr: 'Jetons d’API',
        de: 'API-Tokens',
        pt: 'Tokens de API',
        it: 'Token API',
        ja: 'API トークン',
        ko: 'API 토큰',
        zh: 'API 令牌',
        ru: 'API-токены',
        ro: 'Tokenuri API',
    },
    icon: '🔑',
    group: 'access',
    order: 10,
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-tokens`. `false` or no build leaves it out.
 */
export function tokensDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-tokens', require), TOKENS_DASHBOARD_MODULE);
}
