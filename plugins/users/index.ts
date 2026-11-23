export { CliUsersBuilder, generatePassword } from './cli-users-builder';
export { UsersServerAuth, EXTERNAL_REQUEST, toQcliCaller, GUARD_ONLY_NEEDS_NO_CLI_ROUTES, ON_REFUSED } from './server-auth';
export type { UsersServerAuthContext, UsersServerAttachment } from './server-auth';
export { RequestAuthenticator } from './middleware/auth-middleware';
export { hashToken, isOriginAllowed, isSameOrigin, requestOrigin } from './security';
export type { UsersPluginResult } from './cli-users-builder';
export type {
    UsersModuleOptions,
    AuthAdapter,
    ExternalAuthResult,
    UsersBroadcastFn,
    User,
    CreateUserDto,
    UpdateUserDto,
    Credentials,
    Session,
    SessionMetadata,
    SessionView,
    SessionPayload,
    LoginResult,
    AuditEntry,
    AuditQueryOptions,
    Group,
    CreateGroupDto,
    UpdateGroupDto,
    ApiToken,
    ApiTokenAudience,
    ApiTokenView,
    ApiTokenUsage,
    ApiTokenUsageDay,
    TokenUsageProvider,
    QcliCaller,
    ApiTokenCreateOptions,
    CreatedApiToken,
    CreateApiTokenResult,
    CliPermission,
    UsersPermissionCatalog,
} from './models';
export type { ICliUserStore, ICliSessionStore, ICliCredentialStore, ICliAuditStore, ICliGroupStore, ICliApiTokenStore } from './stores/interfaces';
export { pruneAudit } from './stores/interfaces';
export { usersInstalledPlugin } from './package-info';
export type { CliInstalledPlugin } from './package-info';
export { InMemoryApiTokenStore } from './stores/in-memory-api-token-store';
export { InMemoryUserStore } from './stores/in-memory-user-store';
export { InMemorySessionStore } from './stores/in-memory-session-store';
export { InMemoryCredentialStore } from './stores/in-memory-credential-store';
// The audit log moved to @qodalis/cli-server-plugin-audit; re-exported for existing imports.
export { InMemoryAuditStore, CliAuditBuilder } from '@qodalis/cli-server-plugin-audit';
export type { CliAuditPluginResult } from '@qodalis/cli-server-plugin-audit';
export { InMemoryGroupStore } from './stores/in-memory-group-store';
export {
    AuthService,
    toUserJson,
    isApiToken,
    tokenAudience,
    API_TOKEN_PREFIX,
    MAX_API_TOKENS_PER_USER,
    HOST_TOKENS_CREATED_BY_HOST,
    INVALID_AUDIENCE,
    HOST_TOKENS_NEED_PERMISSIONS,
    NOT_A_HOST_PERMISSION,
    EXPIRY_CONFLICT,
    HOST_TOKENS_CANNOT_USE_CLI_ROUTES,
    HOST_TOKEN_REQUIRED,
    isHostToken,
    hostTokenRefused,
} from './services/auth-service';
export { ApiTokenManager } from './services/api-token-manager';
export type { AuthContext, AuthServiceOptions, UsersSessionEvent } from './services/auth-service';
export { DirectoryService } from './services/directory-service';
export { hashPassword, verifyPasswordHash, PBKDF2_ITERATIONS } from './services/password-hasher';
export {
    permissionMatches,
    hasPermission,
    mergePermissions,
    UsersPermissions,
    USERS_PERMISSION_ENTRIES,
    LocalPermissionCatalog,
} from './permissions';
export { createPermissionsController } from './controllers/permissions-controller';
export { HttpError } from './errors';
export { TOKENS_DASHBOARD_MODULE, tokensDashboardPage } from './dashboard-page';
