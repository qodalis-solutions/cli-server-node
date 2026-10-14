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
} from '../models';

export interface ICliUserStore {
    getUsers(): Promise<User[]>;
    /** Lookup by id, then by name (case-insensitive). */
    getUser(idOrName: string): Promise<User | undefined>;
    createUser(data: CreateUserDto): Promise<User>;
    updateUser(id: string, data: UpdateUserDto): Promise<User>;
    deleteUser(id: string): Promise<void>;
}

export interface ICliSessionStore {
    createSession(userId: string, token: string, metadata: SessionMetadata): Promise<Session>;
    getSession(token: string): Promise<Session | undefined>;
    getSessionById(id: string): Promise<Session | undefined>;
    getActiveSessions(): Promise<Session[]>;
    deleteSession(token: string): Promise<void>;
    deleteSessionById(id: string): Promise<void>;
    deleteUserSessions(userId: string): Promise<void>;
    updateLastActivity(token: string): Promise<void>;
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
