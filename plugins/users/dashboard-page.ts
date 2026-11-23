import { existsSync } from 'fs';
import { dirname, join } from 'path';
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

/** The admin dashboard's Users page (users, groups, sessions): `@qodalis/cli-dashboard-module-users`, served at `/qcli/modules/users`. */
export const USERS_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'users',
    title: 'Users',
    titles: {
        de: 'Benutzer',
        es: 'Usuarios',
        fr: 'Utilisateurs',
        it: 'Utenti',
        ja: 'ユーザー',
        ko: '사용자',
        pt: 'Usuários',
        ro: 'Utilizatori',
        ru: 'Пользователи',
        zh: '用户',
    },
    icon: '👥',
    group: 'access',
    order: 5,
    permission: 'users:read',
    search: '/?q=',
};

/**
 * The signed-in user's Account page (profile, password change; every user): the same build as the Users page, which
 * renders it for this id, served at `/qcli/modules/account` and listed in the dashboard's account menu.
 */
export const ACCOUNT_DASHBOARD_MODULE: CliDashboardModuleInfo = {
    id: 'account',
    title: 'Account',
    titles: {
        de: 'Konto',
        es: 'Cuenta',
        fr: 'Compte',
        it: 'Account',
        ja: 'アカウント',
        ko: '계정',
        pt: 'Conta',
        ro: 'Cont',
        ru: 'Учётная запись',
        zh: '账户',
    },
    icon: '👤',
    group: 'account',
    order: 0,
};

/**
 * The page from its build: `dir`, else the copy next to the package (`npm run copy-dashboard`), else the installed
 * `@qodalis/cli-dashboard-module-tokens`. `false` or no build leaves it out.
 */
export function tokensDashboardPage(dir?: string | false): CliDashboardModulePage | undefined {
    return resolveDashboardModulePage(dir, () => findDashboardModule(__dirname, '@qodalis/cli-dashboard-module-tokens', require), TOKENS_DASHBOARD_MODULE);
}

/** The Users module's build: the copy next to the package (`dashboard-users/`, also one folder up from `dist/`), else the installed package. */
function findUsersModule(): string | undefined {
    const candidates = [join(__dirname, 'dashboard-users'), join(__dirname, '..', 'dashboard-users')];
    try {
        candidates.push(join(dirname(require.resolve('@qodalis/cli-dashboard-module-users/package.json')), 'dist'));
    } catch {
        // Not installed
    }
    return candidates.find((dir) => existsSync(join(dir, 'extension.js')));
}

/**
 * The Users and Account pages from `@qodalis/cli-dashboard-module-users`: `dir`, else the copy next to the package
 * (`npm run copy-dashboard`), else the installed package. `false` or no build leaves both out.
 */
export function usersDashboardPages(dir?: string | false): CliDashboardModulePage[] {
    const build = dir === false ? false : (dir ?? findUsersModule() ?? false);
    return [USERS_DASHBOARD_MODULE, ACCOUNT_DASHBOARD_MODULE]
        .map((info) => resolveDashboardModulePage(build, () => undefined, info))
        .filter((page): page is CliDashboardModulePage => page !== undefined);
}
