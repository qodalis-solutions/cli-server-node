import { randomUUID } from 'crypto';
import { Pool, PoolConfig } from 'pg';
import { qcliTableName, type AuditEntry, type AuditQueryOptions, type CliTableNameOptions, type ICliAuditStore } from '@qodalis/cli-server-abstractions';
import {
    CliMigrationRunner,
    adoptLegacyTable,
    codeSource,
    postgresConnection,
    quoteIdent,
    quoteTable,
    tableExists,
    type CliMigrationSource,
    type CliSqlConnection,
} from '@qodalis/cli-server-plugin-databases';
import type {
    ApiToken,
    CreateGroupDto,
    CreateUserDto,
    Credentials,
    Group,
    ICliApiTokenStore,
    ICliCredentialStore,
    ICliGroupStore,
    ICliSessionStore,
    ICliUserStore,
    Session,
    SessionMetadata,
    UpdateGroupDto,
    UpdateUserDto,
    User,
} from '@qodalis/cli-server-plugin-users';

/**
 * Table names: `QcliUsers`, `QcliGroups`, `QcliCredentials`, `QcliSessions`, `QcliApiTokens`, `QcliAuditEntries`
 * (plugin tables are `Qcli` + PascalCase), changed with `tablePrefix`, per table with `tables` (`{ Users: 'MyUsers' }`),
 * and placed in `schema`.
 */
export type PostgresUsersStoresOptions = Pick<CliTableNameOptions, 'tablePrefix' | 'tables' | 'schema'>;

/** The stores the users plugin takes, kept in PostgreSQL. Call `init()` before use. */
export interface PostgresUsersStores {
    userStore: PostgresUserStore;
    groupStore: PostgresGroupStore;
    credentialStore: PostgresCredentialStore;
    sessionStore: PostgresSessionStore;
    apiTokenStore: PostgresApiTokenStore;
    auditStore: PostgresAuditStore;
    /**
     * Applies the schema migrations the database does not have yet (source `qcli-users`, history in
     * `QcliMigrations`); safe to run on every start, also from several processes at once.
     */
    init(): Promise<void>;
    /** The database, for the databases plugin (`addDatabase('users', { connection })`). */
    connection: CliSqlConnection;
    /** The stores' migrations (`qcli-users`), to show and run them from the databases plugin. */
    migrationSource: CliMigrationSource;
    /** Closes the pool when the stores created it. */
    close(): Promise<void>;
}

/** Epoch milliseconds are kept in `bigint` columns, which `pg` returns as strings. */
const ms = (value: unknown): number => Number(value);
const optionalMs = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));

/** A unique-index violation (duplicate name, email, ...). */
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

/** The stores' tables, by their base names (`Users` → `QcliUsers`). */
const TABLES = ['Users', 'Groups', 'Credentials', 'Sessions', 'ApiTokens', 'AuditEntries'] as const;

/** The tables of the never-published first version (`qcli_users`, ...), adopted by migration 1. */
const LEGACY: Record<(typeof TABLES)[number], { table: string; columns: Record<string, string>; indexes: Record<string, string> }> = {
    Users: {
        table: 'qcli_users',
        columns: { id: 'Id', name: 'Name', email: 'Email', groups: 'Groups', disabled: 'Disabled', must_change_password: 'MustChangePassword', home_dir: 'HomeDir', data: 'Data', last_login_at: 'LastLoginAt', created_at: 'CreatedAt', updated_at: 'UpdatedAt' },
        indexes: { qcli_users_name_key: 'Name', qcli_users_email_key: 'Email', qcli_users_pkey: '' },
    },
    Groups: {
        table: 'qcli_groups',
        columns: { id: 'Id', name: 'Name', description: 'Description', permissions: 'Permissions', built_in: 'BuiltIn', created_at: 'CreatedAt', updated_at: 'UpdatedAt' },
        indexes: { qcli_groups_name_key: 'Name', qcli_groups_pkey: '' },
    },
    Credentials: {
        table: 'qcli_credentials',
        columns: { user_id: 'UserId', password_hash: 'PasswordHash', salt: 'Salt', last_changed: 'LastChanged' },
        indexes: { qcli_credentials_pkey: '' },
    },
    Sessions: {
        table: 'qcli_sessions',
        columns: { token_hash: 'TokenHash', id: 'Id', user_id: 'UserId', created_at: 'CreatedAt', last_activity: 'LastActivity', metadata: 'Metadata' },
        indexes: { qcli_sessions_user_idx: 'UserId', qcli_sessions_id_key: 'Id', qcli_sessions_pkey: '' },
    },
    ApiTokens: {
        table: 'qcli_api_tokens',
        columns: { id: 'Id', user_id: 'UserId', name: 'Name', token_hash: 'TokenHash', created_at: 'CreatedAt', expires_at: 'ExpiresAt', last_used_at: 'LastUsedAt', audience: 'Audience', permissions: 'Permissions' },
        indexes: { qcli_api_tokens_user_idx: 'UserId', qcli_api_tokens_token_hash_key: 'TokenHash', qcli_api_tokens_pkey: '' },
    },
    AuditEntries: {
        table: 'qcli_audit',
        columns: { seq: 'Seq', id: 'Id', timestamp: 'Timestamp', event: 'Event', username: 'Username', actor: 'Actor', entry: 'Entry' },
        indexes: { qcli_audit_timestamp_idx: 'Timestamp', qcli_audit_pkey: '' },
    },
};

class Tables {
    /** Quoted names, ready for SQL. */
    readonly users: string;
    readonly groups: string;
    readonly credentials: string;
    readonly sessions: string;
    readonly tokens: string;
    readonly audit: string;
    /** Unquoted names by base name. */
    readonly names: Record<(typeof TABLES)[number], string>;

    constructor(readonly options: PostgresUsersStoresOptions) {
        this.names = Object.fromEntries(TABLES.map((t) => [t, qcliTableName(t, options)])) as Tables['names'];
        const q = (t: (typeof TABLES)[number]) => quoteTable('postgres', this.names[t], options.schema);
        this.users = q('Users');
        this.groups = q('Groups');
        this.credentials = q('Credentials');
        this.sessions = q('Sessions');
        this.tokens = q('ApiTokens');
        this.audit = q('AuditEntries');
    }

    /** The schema's history (source `qcli-users`): append new migrations, never edit released ones. */
    source(): CliMigrationSource {
        const n = this.names;
        const schema = this.options.schema;
        const ix = (table: string, ...columns: string[]) => quoteIdent('postgres', `IX_${table}_${columns.join('_')}`);
        return codeSource('qcli-users', [
            {
                id: '1',
                name: 'users, groups, credentials, sessions, api tokens, audit',
                up: async (db) => {
                    // The first version's qcli_* tables (plugins.qodalis.com): renamed with their data
                    for (const base of TABLES) {
                        const legacy = LEGACY[base];
                        if (!(await adoptLegacyTable(db, legacy.table, n[base], legacy.columns, schema))) continue;
                        for (const [index, column] of Object.entries(legacy.indexes)) {
                            const to = column ? `IX_${n[base]}_${column}` : `PK_${n[base]}`;
                            await db.exec(`ALTER INDEX IF EXISTS ${schema ? `${quoteIdent('postgres', schema)}.` : ''}${quoteIdent('postgres', index)} RENAME TO ${quoteIdent('postgres', to)}`);
                        }
                    }
                    if (await tableExists(db, 'qcli_schema_migrations', schema)) await db.exec(`DROP TABLE ${quoteTable('postgres', 'qcli_schema_migrations', schema)}`);
                    await db.exec(`
CREATE TABLE IF NOT EXISTS ${this.users} (
    "Id" text CONSTRAINT ${quoteIdent('postgres', `PK_${n.Users}`)} PRIMARY KEY,
    "Name" text NOT NULL,
    "Email" text NOT NULL,
    "Groups" jsonb NOT NULL DEFAULT '[]',
    "Disabled" boolean NOT NULL DEFAULT false,
    "MustChangePassword" boolean NOT NULL DEFAULT false,
    "HomeDir" text,
    "Data" jsonb,
    "LastLoginAt" bigint,
    "CreatedAt" bigint NOT NULL,
    "UpdatedAt" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${ix(n.Users, 'Name')} ON ${this.users} (lower("Name"));
CREATE UNIQUE INDEX IF NOT EXISTS ${ix(n.Users, 'Email')} ON ${this.users} (lower("Email"));
CREATE TABLE IF NOT EXISTS ${this.groups} (
    "Id" text CONSTRAINT ${quoteIdent('postgres', `PK_${n.Groups}`)} PRIMARY KEY,
    "Name" text NOT NULL,
    "Description" text,
    "Permissions" jsonb NOT NULL DEFAULT '[]',
    "BuiltIn" boolean NOT NULL DEFAULT false,
    "CreatedAt" bigint NOT NULL,
    "UpdatedAt" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${ix(n.Groups, 'Name')} ON ${this.groups} (lower("Name"));
CREATE TABLE IF NOT EXISTS ${this.credentials} (
    "UserId" text CONSTRAINT ${quoteIdent('postgres', `PK_${n.Credentials}`)} PRIMARY KEY,
    "PasswordHash" text NOT NULL,
    "Salt" text NOT NULL,
    "LastChanged" bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS ${this.sessions} (
    "TokenHash" text CONSTRAINT ${quoteIdent('postgres', `PK_${n.Sessions}`)} PRIMARY KEY,
    "Id" text NOT NULL CONSTRAINT ${ix(n.Sessions, 'Id')} UNIQUE,
    "UserId" text NOT NULL,
    "CreatedAt" bigint NOT NULL,
    "LastActivity" bigint NOT NULL,
    "Metadata" jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ${ix(n.Sessions, 'UserId')} ON ${this.sessions} ("UserId");
CREATE TABLE IF NOT EXISTS ${this.tokens} (
    "Id" text CONSTRAINT ${quoteIdent('postgres', `PK_${n.ApiTokens}`)} PRIMARY KEY,
    "UserId" text NOT NULL,
    "Name" text NOT NULL,
    "TokenHash" text NOT NULL CONSTRAINT ${ix(n.ApiTokens, 'TokenHash')} UNIQUE,
    "CreatedAt" bigint NOT NULL,
    "ExpiresAt" bigint,
    "LastUsedAt" bigint,
    "Audience" text,
    "Permissions" jsonb
);
CREATE INDEX IF NOT EXISTS ${ix(n.ApiTokens, 'UserId')} ON ${this.tokens} ("UserId");
CREATE TABLE IF NOT EXISTS ${this.audit} (
    "Seq" bigserial CONSTRAINT ${quoteIdent('postgres', `PK_${n.AuditEntries}`)} PRIMARY KEY,
    "Id" text NOT NULL,
    "Timestamp" bigint NOT NULL,
    "Event" text NOT NULL,
    "Username" text,
    "Actor" text,
    "Entry" jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ${ix(n.AuditEntries, 'Timestamp')} ON ${this.audit} ("Timestamp");
`);
                },
            },
        ]);
    }
}

/**
 * Creates the PostgreSQL stores of the users plugin on one pool.
 *
 * @param config A connection string, pool settings, or a pool the host owns (then `close()`
 *   leaves it open).
 *
 * @example
 * ```ts
 * const stores = createPostgresUsersStores(process.env.DATABASE_URL!);
 * await stores.init();
 * const users = new CliUsersBuilder()
 *     .setUserStore(stores.userStore)
 *     .setGroupStore(stores.groupStore)
 *     .setCredentialStore(stores.credentialStore)
 *     .setSessionStore(stores.sessionStore)
 *     .setApiTokenStore(stores.apiTokenStore)
 *     .setAuditStore(stores.auditStore)
 *     .build(cli.eventBus);
 * ```
 */
export function createPostgresUsersStores(config: string | PoolConfig | Pool, options: PostgresUsersStoresOptions = {}): PostgresUsersStores {
    const owned = !(config instanceof Pool);
    const pool = config instanceof Pool ? config : new Pool(typeof config === 'string' ? { connectionString: config } : config);
    const tables = new Tables(options);
    const connection = postgresConnection(pool);
    const migrationSource = tables.source();
    return {
        userStore: new PostgresUserStore(pool, tables),
        groupStore: new PostgresGroupStore(pool, tables),
        credentialStore: new PostgresCredentialStore(pool, tables),
        sessionStore: new PostgresSessionStore(pool, tables),
        apiTokenStore: new PostgresApiTokenStore(pool, tables),
        auditStore: new PostgresAuditStore(pool, tables),
        connection,
        migrationSource,
        init: async () => {
            const runner = new CliMigrationRunner('users', { connection, tablePrefix: options.tablePrefix, schema: options.schema }).addSource(migrationSource);
            const run = await runner.up({ trigger: 'startup', wait: true });
            if ('status' in run && run.status === 'failed') throw new Error(`users-postgres schema: ${run.error}`);
        },
        close: async () => {
            if (owned) await pool.end();
        },
    };
}

/** Users; names and emails are unique ignoring case. */
export class PostgresUserStore implements ICliUserStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async getUsers(): Promise<User[]> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "Name" AS name, "Email" AS email, "Groups" AS groups, "Disabled" AS disabled, "MustChangePassword" AS must_change_password, "HomeDir" AS home_dir, "Data" AS data, "LastLoginAt" AS last_login_at, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at FROM ${this.t.users} ORDER BY "CreatedAt", "Name"`);
        return rows.map(toUser);
    }

    async getUser(idOrName: string): Promise<User | undefined> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "Name" AS name, "Email" AS email, "Groups" AS groups, "Disabled" AS disabled, "MustChangePassword" AS must_change_password, "HomeDir" AS home_dir, "Data" AS data, "LastLoginAt" AS last_login_at, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at FROM ${this.t.users} WHERE "Id" = $1 OR lower("Name") = lower($1) ORDER BY ("Id" = $1) DESC LIMIT 1`, [idOrName]);
        return rows[0] ? toUser(rows[0]) : undefined;
    }

    private async assertUnique(name: string | undefined, email: string | undefined, exceptId?: string): Promise<void> {
        if (name !== undefined) {
            const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE lower("Name") = lower($1) AND "Id" IS DISTINCT FROM $2`, [name, exceptId ?? null]);
            if (rowCount) throw new Error(`User with name '${name}' already exists`);
        }
        if (email !== undefined) {
            const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE lower("Email") = lower($1) AND "Id" IS DISTINCT FROM $2`, [email, exceptId ?? null]);
            if (rowCount) throw new Error(`User with email '${email}' already exists`);
        }
    }

    async createUser(data: CreateUserDto): Promise<User> {
        await this.assertUnique(data.name, data.email);
        const now = Date.now();
        try {
            const { rows } = await this.pool.query(
                `INSERT INTO ${this.t.users} ("Id", "Name", "Email", "Groups", "Disabled", "MustChangePassword", "HomeDir", "Data", "CreatedAt", "UpdatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING "Id" AS id, "Name" AS name, "Email" AS email, "Groups" AS groups, "Disabled" AS disabled, "MustChangePassword" AS must_change_password, "HomeDir" AS home_dir, "Data" AS data, "LastLoginAt" AS last_login_at, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at`,
                [
                    randomUUID(),
                    data.name,
                    data.email,
                    JSON.stringify(data.groups ?? []),
                    data.disabled ?? false,
                    data.mustChangePassword ?? false,
                    data.homeDir ?? null,
                    data.data !== undefined ? JSON.stringify(data.data) : null,
                    now,
                ],
            );
            return toUser(rows[0]);
        } catch (err) {
            // a concurrent create won the race: the same error as the check above
            if (isUniqueViolation(err)) await this.assertUnique(data.name, data.email);
            throw err;
        }
    }

    async updateUser(id: string, data: UpdateUserDto): Promise<User> {
        const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE "Id" = $1`, [id]);
        if (!rowCount) throw new Error(`User with id '${id}' not found`);
        await this.assertUnique(data.name, data.email, id);
        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if (data.name !== undefined) set('"Name"', data.name);
        if (data.email !== undefined) set('"Email"', data.email);
        if (data.groups !== undefined) set('"Groups"', JSON.stringify(data.groups));
        if (data.disabled !== undefined) set('"Disabled"', data.disabled);
        if (data.mustChangePassword !== undefined) set('"MustChangePassword"', data.mustChangePassword);
        if (data.homeDir !== undefined) set('"HomeDir"', data.homeDir);
        if (data.data !== undefined) set('"Data"', JSON.stringify(data.data));
        if (data.lastLoginAt !== undefined) set('"LastLoginAt"', data.lastLoginAt);
        set('"UpdatedAt"', Date.now());
        let rows: Record<string, unknown>[];
        try {
            ({ rows } = await this.pool.query(`UPDATE ${this.t.users} SET ${sets.join(', ')} WHERE "Id" = $1 RETURNING "Id" AS id, "Name" AS name, "Email" AS email, "Groups" AS groups, "Disabled" AS disabled, "MustChangePassword" AS must_change_password, "HomeDir" AS home_dir, "Data" AS data, "LastLoginAt" AS last_login_at, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at`, values));
        } catch (err) {
            // a concurrent rename or create took the name or email: the same error as the check above
            if (isUniqueViolation(err)) await this.assertUnique(data.name, data.email, id);
            throw err;
        }
        if (!rows[0]) throw new Error(`User with id '${id}' not found`);
        return toUser(rows[0]);
    }

    async deleteUser(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.users} WHERE "Id" = $1`, [id]);
    }
}

function toUser(row: Record<string, unknown>): User {
    return {
        id: row.id as string,
        name: row.name as string,
        email: row.email as string,
        groups: [...((row.groups as string[]) ?? [])],
        disabled: row.disabled as boolean,
        mustChangePassword: row.must_change_password as boolean,
        ...(row.home_dir !== null && row.home_dir !== undefined ? { homeDir: row.home_dir as string } : {}),
        ...(row.data !== null && row.data !== undefined ? { data: row.data as Record<string, unknown> } : {}),
        ...(row.last_login_at !== null && row.last_login_at !== undefined ? { lastLoginAt: ms(row.last_login_at) } : {}),
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
    };
}

/** Groups; names are unique ignoring case and kept as given. */
export class PostgresGroupStore implements ICliGroupStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async getGroups(): Promise<Group[]> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "Name" AS name, "Description" AS description, "Permissions" AS permissions, "BuiltIn" AS built_in, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at FROM ${this.t.groups} ORDER BY "CreatedAt", "Name"`);
        return rows.map(toGroup);
    }

    async getGroup(name: string): Promise<Group | undefined> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "Name" AS name, "Description" AS description, "Permissions" AS permissions, "BuiltIn" AS built_in, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at FROM ${this.t.groups} WHERE lower("Name") = lower($1)`, [name]);
        return rows[0] ? toGroup(rows[0]) : undefined;
    }

    async createGroup(data: CreateGroupDto): Promise<Group> {
        const now = Date.now();
        try {
            const { rows } = await this.pool.query(
                `INSERT INTO ${this.t.groups} ("Id", "Name", "Description", "Permissions", "BuiltIn", "CreatedAt", "UpdatedAt")
                 VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING "Id" AS id, "Name" AS name, "Description" AS description, "Permissions" AS permissions, "BuiltIn" AS built_in, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at`,
                [randomUUID(), data.name, data.description ?? null, JSON.stringify(data.permissions ?? []), data.builtIn ?? false, now],
            );
            return toGroup(rows[0]);
        } catch (err) {
            if (isUniqueViolation(err)) throw new Error(`Group '${data.name}' already exists`);
            throw err;
        }
    }

    async updateGroup(name: string, data: UpdateGroupDto): Promise<Group> {
        const sets: string[] = [];
        const values: unknown[] = [name];
        if (data.description !== undefined) {
            values.push(data.description);
            sets.push(`"Description" = $${values.length}`);
        }
        if (data.permissions !== undefined) {
            values.push(JSON.stringify(data.permissions));
            sets.push(`"Permissions" = $${values.length}`);
        }
        values.push(Date.now());
        sets.push(`"UpdatedAt" = $${values.length}`);
        const { rows } = await this.pool.query(`UPDATE ${this.t.groups} SET ${sets.join(', ')} WHERE lower("Name") = lower($1) RETURNING "Id" AS id, "Name" AS name, "Description" AS description, "Permissions" AS permissions, "BuiltIn" AS built_in, "CreatedAt" AS created_at, "UpdatedAt" AS updated_at`, values);
        if (!rows[0]) throw new Error(`Group '${name}' not found`);
        return toGroup(rows[0]);
    }

    async deleteGroup(name: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.groups} WHERE lower("Name") = lower($1)`, [name]);
    }
}

function toGroup(row: Record<string, unknown>): Group {
    return {
        id: row.id as string,
        name: row.name as string,
        ...(row.description !== null && row.description !== undefined ? { description: row.description as string } : {}),
        permissions: [...((row.permissions as string[]) ?? [])],
        builtIn: row.built_in as boolean,
        createdAt: ms(row.created_at),
        updatedAt: ms(row.updated_at),
    };
}

/** Password hashes and salts, one row per user. */
export class PostgresCredentialStore implements ICliCredentialStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async setPassword(userId: string, hash: string, salt: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO ${this.t.credentials} ("UserId", "PasswordHash", "Salt", "LastChanged") VALUES ($1, $2, $3, $4)
             ON CONFLICT ("UserId") DO UPDATE SET "PasswordHash" = EXCLUDED."PasswordHash", "Salt" = EXCLUDED."Salt", "LastChanged" = EXCLUDED."LastChanged"`,
            [userId, hash, salt, Date.now()],
        );
    }

    async getCredentials(userId: string): Promise<Credentials | undefined> {
        const { rows } = await this.pool.query(`SELECT "UserId" AS user_id, "PasswordHash" AS password_hash, "Salt" AS salt, "LastChanged" AS last_changed FROM ${this.t.credentials} WHERE "UserId" = $1`, [userId]);
        const row = rows[0];
        return row ? { userId: row.user_id, passwordHash: row.password_hash, salt: row.salt, lastChanged: ms(row.last_changed) } : undefined;
    }

    async deleteCredentials(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.credentials} WHERE "UserId" = $1`, [userId]);
    }
}

/** Sessions, keyed by the token's SHA-256 (raw tokens are never stored). */
export class PostgresSessionStore implements ICliSessionStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async createSession(userId: string, tokenHash: string, metadata: SessionMetadata): Promise<Session> {
        const now = Date.now();
        const { rows } = await this.pool.query(
            `INSERT INTO ${this.t.sessions} ("TokenHash", "Id", "UserId", "CreatedAt", "LastActivity", "Metadata") VALUES ($1, $2, $3, $4, $4, $5)
             ON CONFLICT ("TokenHash") DO UPDATE SET "Id" = EXCLUDED."Id", "UserId" = EXCLUDED."UserId", "CreatedAt" = EXCLUDED."CreatedAt",
                 "LastActivity" = EXCLUDED."LastActivity", "Metadata" = EXCLUDED."Metadata"
             RETURNING "TokenHash" AS token_hash, "Id" AS id, "UserId" AS user_id, "CreatedAt" AS created_at, "LastActivity" AS last_activity, "Metadata" AS metadata`,
            [tokenHash, randomUUID(), userId, now, JSON.stringify({ ...metadata })],
        );
        return toSession(rows[0]);
    }

    async getSession(tokenHash: string): Promise<Session | undefined> {
        const { rows } = await this.pool.query(`SELECT "TokenHash" AS token_hash, "Id" AS id, "UserId" AS user_id, "CreatedAt" AS created_at, "LastActivity" AS last_activity, "Metadata" AS metadata FROM ${this.t.sessions} WHERE "TokenHash" = $1`, [tokenHash]);
        return rows[0] ? toSession(rows[0]) : undefined;
    }

    async getSessionById(id: string): Promise<Session | undefined> {
        const { rows } = await this.pool.query(`SELECT "TokenHash" AS token_hash, "Id" AS id, "UserId" AS user_id, "CreatedAt" AS created_at, "LastActivity" AS last_activity, "Metadata" AS metadata FROM ${this.t.sessions} WHERE "Id" = $1`, [id]);
        return rows[0] ? toSession(rows[0]) : undefined;
    }

    async getActiveSessions(): Promise<Session[]> {
        const { rows } = await this.pool.query(`SELECT "TokenHash" AS token_hash, "Id" AS id, "UserId" AS user_id, "CreatedAt" AS created_at, "LastActivity" AS last_activity, "Metadata" AS metadata FROM ${this.t.sessions} ORDER BY "CreatedAt"`);
        return rows.map(toSession);
    }

    async deleteSession(tokenHash: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE "TokenHash" = $1`, [tokenHash]);
    }

    async deleteSessionById(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE "Id" = $1`, [id]);
    }

    async deleteUserSessions(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE "UserId" = $1`, [userId]);
    }

    async updateLastActivity(tokenHash: string): Promise<void> {
        await this.pool.query(`UPDATE ${this.t.sessions} SET "LastActivity" = $2 WHERE "TokenHash" = $1`, [tokenHash, Date.now()]);
    }

    async cleanup(maxAgeMs: number): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE "LastActivity" < $1`, [Date.now() - maxAgeMs]);
    }
}

function toSession(row: Record<string, unknown>): Session {
    return {
        id: row.id as string,
        tokenHash: row.token_hash as string,
        userId: row.user_id as string,
        createdAt: ms(row.created_at),
        lastActivity: ms(row.last_activity),
        metadata: { ...((row.metadata as SessionMetadata) ?? {}) },
    };
}

/** API tokens, found by the token's SHA-256 (raw tokens are never stored). */
export class PostgresApiTokenStore implements ICliApiTokenStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async createToken(token: ApiToken): Promise<ApiToken> {
        const { rows } = await this.pool.query(
            `INSERT INTO ${this.t.tokens} ("Id", "UserId", "Name", "TokenHash", "CreatedAt", "ExpiresAt", "LastUsedAt", "Audience", "Permissions")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT ("Id") DO UPDATE SET "UserId" = EXCLUDED."UserId", "Name" = EXCLUDED."Name", "TokenHash" = EXCLUDED."TokenHash",
                 "CreatedAt" = EXCLUDED."CreatedAt", "ExpiresAt" = EXCLUDED."ExpiresAt", "LastUsedAt" = EXCLUDED."LastUsedAt",
                 "Audience" = EXCLUDED."Audience", "Permissions" = EXCLUDED."Permissions"
             RETURNING "Id" AS id, "UserId" AS user_id, "Name" AS name, "TokenHash" AS token_hash, "CreatedAt" AS created_at, "ExpiresAt" AS expires_at, "LastUsedAt" AS last_used_at, "Audience" AS audience, "Permissions" AS permissions`,
            [
                token.id,
                token.userId,
                token.name,
                token.tokenHash,
                token.createdAt,
                token.expiresAt,
                token.lastUsedAt ?? null,
                token.audience ?? null,
                token.permissions ? JSON.stringify(token.permissions) : null,
            ],
        );
        return toToken(rows[0]);
    }

    async getTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "UserId" AS user_id, "Name" AS name, "TokenHash" AS token_hash, "CreatedAt" AS created_at, "ExpiresAt" AS expires_at, "LastUsedAt" AS last_used_at, "Audience" AS audience, "Permissions" AS permissions FROM ${this.t.tokens} WHERE "TokenHash" = $1`, [tokenHash]);
        return rows[0] ? toToken(rows[0]) : undefined;
    }

    async getToken(id: string): Promise<ApiToken | undefined> {
        const { rows } = await this.pool.query(`SELECT "Id" AS id, "UserId" AS user_id, "Name" AS name, "TokenHash" AS token_hash, "CreatedAt" AS created_at, "ExpiresAt" AS expires_at, "LastUsedAt" AS last_used_at, "Audience" AS audience, "Permissions" AS permissions FROM ${this.t.tokens} WHERE "Id" = $1`, [id]);
        return rows[0] ? toToken(rows[0]) : undefined;
    }

    async getTokens(userId?: string): Promise<ApiToken[]> {
        const { rows } =
            userId === undefined
                ? await this.pool.query(`SELECT "Id" AS id, "UserId" AS user_id, "Name" AS name, "TokenHash" AS token_hash, "CreatedAt" AS created_at, "ExpiresAt" AS expires_at, "LastUsedAt" AS last_used_at, "Audience" AS audience, "Permissions" AS permissions FROM ${this.t.tokens} ORDER BY "CreatedAt"`)
                : await this.pool.query(`SELECT "Id" AS id, "UserId" AS user_id, "Name" AS name, "TokenHash" AS token_hash, "CreatedAt" AS created_at, "ExpiresAt" AS expires_at, "LastUsedAt" AS last_used_at, "Audience" AS audience, "Permissions" AS permissions FROM ${this.t.tokens} WHERE "UserId" = $1 ORDER BY "CreatedAt"`, [userId]);
        return rows.map(toToken);
    }

    async deleteToken(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.tokens} WHERE "Id" = $1`, [id]);
    }

    async deleteUserTokens(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.tokens} WHERE "UserId" = $1`, [userId]);
    }

    async updateLastUsed(id: string, lastUsedAt: number): Promise<void> {
        await this.pool.query(`UPDATE ${this.t.tokens} SET "LastUsedAt" = $2 WHERE "Id" = $1`, [id, lastUsedAt]);
    }
}

function toToken(row: Record<string, unknown>): ApiToken {
    return {
        id: row.id as string,
        userId: row.user_id as string,
        name: row.name as string,
        tokenHash: row.token_hash as string,
        createdAt: ms(row.created_at),
        expiresAt: optionalMs(row.expires_at) ?? null,
        ...(row.last_used_at !== null && row.last_used_at !== undefined ? { lastUsedAt: ms(row.last_used_at) } : {}),
        ...(row.audience !== null && row.audience !== undefined ? { audience: row.audience as ApiToken['audience'] } : {}),
        ...(row.permissions !== null && row.permissions !== undefined ? { permissions: [...(row.permissions as string[])] } : {}),
    };
}

/**
 * The audit log. Unlike the in-memory store it keeps every entry: bound it with
 * `pruneAudit(store, before)` on a schedule (e.g. a jobs-plugin job).
 */
export class PostgresAuditStore implements ICliAuditStore {
    constructor(
        private readonly pool: Pool,
        private readonly t: Tables,
    ) {}

    async log(entry: AuditEntry): Promise<void> {
        const stored: AuditEntry = { ...entry, id: entry.id ?? randomUUID(), timestamp: entry.timestamp ?? Date.now() };
        await this.pool.query(`INSERT INTO ${this.t.audit} ("Id", "Timestamp", "Event", "Username", "Actor", "Entry") VALUES ($1, $2, $3, $4, $5, $6)`, [
            stored.id,
            stored.timestamp,
            stored.event,
            stored.username ?? null,
            stored.actor ?? null,
            JSON.stringify(stored),
        ]);
    }

    async getEntries(options?: AuditQueryOptions): Promise<AuditEntry[]> {
        const where: string[] = [];
        const values: unknown[] = [];
        const add = (sql: string, value: unknown) => {
            values.push(value);
            where.push(sql.replace('?', `$${values.length}`));
        };
        if (options?.event) add('lower("Event") = lower(?)', options.event);
        if (options?.username) add('lower("Username") = lower(?)', options.username);
        if (options?.actor) add('lower("Actor") = lower(?)', options.actor);
        if (options?.from) add('"Timestamp" >= ?', options.from.getTime());
        if (options?.to) add('"Timestamp" < ?', options.to.getTime());
        let sql = `SELECT "Entry" AS entry FROM ${this.t.audit}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY "Seq" DESC`;
        if (options?.limit !== undefined && options.limit > 0) {
            values.push(options.limit);
            sql += ` LIMIT $${values.length}`;
        }
        if (options?.offset !== undefined && options.offset > 0) {
            values.push(options.offset);
            sql += ` OFFSET $${values.length}`;
        }
        const { rows } = await this.pool.query<{ entry: AuditEntry }>(sql, values);
        return rows.map((r) => r.entry);
    }

    async prune(before: Date): Promise<number> {
        const { rowCount } = await this.pool.query(`DELETE FROM ${this.t.audit} WHERE "Timestamp" < $1`, [before.getTime()]);
        return rowCount ?? 0;
    }

    async clear(): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.audit}`);
    }
}
