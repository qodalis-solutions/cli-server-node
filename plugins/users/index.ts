export { CliUsersBuilder, generatePassword } from './cli-users-builder';
export { UsersServerAuth } from './server-auth';
export type { UsersServerAuthContext } from './server-auth';
export { RequestAuthenticator } from './middleware/auth-middleware';
export { hashToken, isOriginAllowed, isSameOrigin, requestOrigin } from './security';
export type { UsersPluginResult } from './cli-users-builder';
export type {
    UsersModuleOptions,
    AuthAdapter,
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
    ApiTokenView,
    CreateApiTokenResult,
} from './models';
export type { ICliUserStore, ICliSessionStore, ICliCredentialStore, ICliAuditStore, ICliGroupStore, ICliApiTokenStore } from './stores/interfaces';
export { InMemoryApiTokenStore } from './stores/in-memory-api-token-store';
export { InMemoryUserStore } from './stores/in-memory-user-store';
export { InMemorySessionStore } from './stores/in-memory-session-store';
export { InMemoryCredentialStore } from './stores/in-memory-credential-store';
export { InMemoryAuditStore } from './stores/in-memory-audit-store';
export { InMemoryGroupStore } from './stores/in-memory-group-store';
export { AuthService, toUserJson, isApiToken, API_TOKEN_PREFIX, MAX_API_TOKENS_PER_USER } from './services/auth-service';
export type { AuthContext, AuthServiceOptions, UsersSessionEvent } from './services/auth-service';
export { DirectoryService } from './services/directory-service';
export { hashPassword, verifyPasswordHash, PBKDF2_ITERATIONS } from './services/password-hasher';
export { permissionMatches, hasPermission, mergePermissions, UsersPermissions } from './permissions';
export { HttpError } from './errors';
