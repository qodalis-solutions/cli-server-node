import {
    User,
    CreateUserDto,
    UpdateUserDto,
    Session,
    SessionMetadata,
    Credentials,
    AuditEntry,
    AuditQueryOptions,
    Group,
    CreateGroupDto,
    UpdateGroupDto,
    ApiToken,
} from '../models';

export interface ICliUserStore {
    getUsers(): Promise<User[]>;
    /** Lookup by id, then by name (case-insensitive). */
    getUser(idOrName: string): Promise<User | undefined>;
    createUser(data: CreateUserDto): Promise<User>;
    updateUser(id: string, data: UpdateUserDto): Promise<User>;
    deleteUser(id: string): Promise<void>;
}

/**
 * Session storage. Every `tokenHash` is `SHA-256(token)` as hex — stores
 * never see raw tokens.
 */
export interface ICliSessionStore {
    createSession(userId: string, tokenHash: string, metadata: SessionMetadata): Promise<Session>;
    getSession(tokenHash: string): Promise<Session | undefined>;
    getSessionById(id: string): Promise<Session | undefined>;
    getActiveSessions(): Promise<Session[]>;
    deleteSession(tokenHash: string): Promise<void>;
    deleteSessionById(id: string): Promise<void>;
    deleteUserSessions(userId: string): Promise<void>;
    updateLastActivity(tokenHash: string): Promise<void>;
    /** Removes sessions idle for longer than `maxAgeMs`. */
    cleanup(maxAgeMs: number): Promise<void>;
}

export interface ICliCredentialStore {
    setPassword(userId: string, hash: string, salt: string): Promise<void>;
    getCredentials(userId: string): Promise<Credentials | undefined>;
    deleteCredentials(userId: string): Promise<void>;
}

export interface ICliAuditStore {
    log(entry: AuditEntry): Promise<void>;
    /** Newest first. */
    getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]>;
    clear(): Promise<void>;
}

export interface ICliGroupStore {
    getGroups(): Promise<Group[]>;
    /** Case-insensitive lookup by name. */
    getGroup(name: string): Promise<Group | undefined>;
    createGroup(group: CreateGroupDto): Promise<Group>;
    updateGroup(name: string, data: UpdateGroupDto): Promise<Group>;
    deleteGroup(name: string): Promise<void>;
}

/**
 * API token storage. `tokenHash` is `SHA-256(token)` as hex — stores never
 * see raw tokens.
 */
export interface ICliApiTokenStore {
    createToken(token: ApiToken): Promise<ApiToken>;
    getTokenByHash(tokenHash: string): Promise<ApiToken | undefined>;
    getToken(id: string): Promise<ApiToken | undefined>;
    /** Every token, or only the tokens of `userId`. */
    getTokens(userId?: string): Promise<ApiToken[]>;
    deleteToken(id: string): Promise<void>;
    deleteUserTokens(userId: string): Promise<void>;
    updateLastUsed(id: string, lastUsedAt: number): Promise<void>;
}
