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
} from '../models';

export interface ICliUserStore {
    getUsers(): Promise<User[]>;
    getUser(idOrName: string): Promise<User | undefined>;
    createUser(data: CreateUserDto): Promise<User>;
    updateUser(id: string, data: UpdateUserDto): Promise<User>;
    deleteUser(id: string): Promise<void>;
}

export interface ICliSessionStore {
    createSession(userId: string, token: string, user: User, metadata: SessionMetadata): Promise<Session>;
    getSession(token: string): Promise<Session | undefined>;
    getSessionById(id: string): Promise<Session | undefined>;
    getActiveSessions(): Promise<Session[]>;
    deleteSession(token: string): Promise<void>;
    deleteSessionById(id: string): Promise<void>;
    deleteUserSessions(userId: string): Promise<void>;
    updateLastActivity(token: string): Promise<void>;
    cleanup(maxAgeMs: number): Promise<void>;
}

export interface ICliCredentialStore {
    setPassword(userId: string, hash: string, salt: string): Promise<void>;
    getCredentials(userId: string): Promise<Credentials | undefined>;
    deleteCredentials(userId: string): Promise<void>;
}

export interface ICliAuditStore {
    log(entry: AuditEntry): Promise<void>;
    getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]>;
    clear(): Promise<void>;
}

export interface ICliGroupStore {
    getGroups(): Promise<Group[]>;
    getGroup(name: string): Promise<Group | undefined>;
    createGroup(name: string, description?: string): Promise<Group>;
    deleteGroup(name: string): Promise<void>;
}
