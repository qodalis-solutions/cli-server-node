import { randomUUID } from 'crypto';
import { Pool, PoolConfig } from 'pg';
import { PostgresMigration, runPostgresMigrations } from './migrations';
import type { AuditEntry, AuditQueryOptions, ICliAuditStore } from '@qodalis/cli-server-abstractions';
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

export interface PostgresUsersStoresOptions {
    /** Prefix of every table (default `qcli_`): `qcli_users`, `qcli_groups`, ... */
    tablePrefix?: string;
}

/** The stores the users plugin takes, kept in PostgreSQL. Call `init()` before use. */
export interface PostgresUsersStores {
    userStore: PostgresUserStore;
    groupStore: PostgresGroupStore;
    credentialStore: PostgresCredentialStore;
    sessionStore: PostgresSessionStore;
    apiTokenStore: PostgresApiTokenStore;
    auditStore: PostgresAuditStore;
    /**
     * Applies the schema migrations the database does not have yet (history in
     * `<prefix>schema_migrations`); safe to run on every start.
     */
    init(): Promise<void>;
    /** Closes the pool when the stores created it. */
    close(): Promise<void>;
}

/** Epoch milliseconds are kept in `bigint` columns, which `pg` returns as strings. */
const ms = (value: unknown): number => Number(value);
const optionalMs = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));

/** A unique-index violation (duplicate name, email, ...). */
const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';

class Tables {
    readonly users: string;
    readonly groups: string;
    readonly credentials: string;
    readonly sessions: string;
    readonly tokens: string;
    readonly audit: string;
    readonly migrations: string;

    constructor(prefix: string) {
        if (!/^[a-z_][a-z0-9_]{0,30}$/.test(prefix)) throw new Error(`invalid table prefix: ${prefix}`);
        this.users = `${prefix}users`;
        this.groups = `${prefix}groups`;
        this.credentials = `${prefix}credentials`;
        this.sessions = `${prefix}sessions`;
        this.tokens = `${prefix}api_tokens`;
        this.audit = `${prefix}audit`;
        this.migrations = `${prefix}schema_migrations`;
    }

    /** The schema's history: append new migrations, never edit released ones. */
    schema(): PostgresMigration[] {
        return [{ id: 1, name: 'users, groups, credentials, sessions, api tokens, audit', up: `
CREATE TABLE IF NOT EXISTS ${this.users} (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL,
    groups jsonb NOT NULL DEFAULT '[]',
    disabled boolean NOT NULL DEFAULT false,
    must_change_password boolean NOT NULL DEFAULT false,
    home_dir text,
    data jsonb,
    last_login_at bigint,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${this.users}_name_key ON ${this.users} (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS ${this.users}_email_key ON ${this.users} (lower(email));
CREATE TABLE IF NOT EXISTS ${this.groups} (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    permissions jsonb NOT NULL DEFAULT '[]',
    built_in boolean NOT NULL DEFAULT false,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ${this.groups}_name_key ON ${this.groups} (lower(name));
CREATE TABLE IF NOT EXISTS ${this.credentials} (
    user_id text PRIMARY KEY,
    password_hash text NOT NULL,
    salt text NOT NULL,
    last_changed bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS ${this.sessions} (
    token_hash text PRIMARY KEY,
    id text NOT NULL UNIQUE,
    user_id text NOT NULL,
    created_at bigint NOT NULL,
    last_activity bigint NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ${this.sessions}_user_idx ON ${this.sessions} (user_id);
CREATE TABLE IF NOT EXISTS ${this.tokens} (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at bigint NOT NULL,
    expires_at bigint,
    last_used_at bigint,
    audience text,
    permissions jsonb
);
CREATE INDEX IF NOT EXISTS ${this.tokens}_user_idx ON ${this.tokens} (user_id);
CREATE TABLE IF NOT EXISTS ${this.audit} (
    seq bigserial PRIMARY KEY,
    id text NOT NULL,
    timestamp bigint NOT NULL,
    event text NOT NULL,
    username text,
    actor text,
    entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ${this.audit}_timestamp_idx ON ${this.audit} (timestamp);
` }];
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
    const tables = new Tables(options.tablePrefix ?? 'qcli_');
    return {
        userStore: new PostgresUserStore(pool, tables),
        groupStore: new PostgresGroupStore(pool, tables),
        credentialStore: new PostgresCredentialStore(pool, tables),
        sessionStore: new PostgresSessionStore(pool, tables),
        apiTokenStore: new PostgresApiTokenStore(pool, tables),
        auditStore: new PostgresAuditStore(pool, tables),
        init: async () => {
            await runPostgresMigrations(pool, tables.migrations, tables.schema());
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
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.users} ORDER BY created_at, name`);
        return rows.map(toUser);
    }

    async getUser(idOrName: string): Promise<User | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.users} WHERE id = $1 OR lower(name) = lower($1) ORDER BY (id = $1) DESC LIMIT 1`, [idOrName]);
        return rows[0] ? toUser(rows[0]) : undefined;
    }

    private async assertUnique(name: string | undefined, email: string | undefined, exceptId?: string): Promise<void> {
        if (name !== undefined) {
            const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2`, [name, exceptId ?? null]);
            if (rowCount) throw new Error(`User with name '${name}' already exists`);
        }
        if (email !== undefined) {
            const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE lower(email) = lower($1) AND id IS DISTINCT FROM $2`, [email, exceptId ?? null]);
            if (rowCount) throw new Error(`User with email '${email}' already exists`);
        }
    }

    async createUser(data: CreateUserDto): Promise<User> {
        await this.assertUnique(data.name, data.email);
        const now = Date.now();
        try {
            const { rows } = await this.pool.query(
                `INSERT INTO ${this.t.users} (id, name, email, groups, disabled, must_change_password, home_dir, data, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`,
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
        const { rowCount } = await this.pool.query(`SELECT 1 FROM ${this.t.users} WHERE id = $1`, [id]);
        if (!rowCount) throw new Error(`User with id '${id}' not found`);
        await this.assertUnique(data.name, data.email, id);
        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (column: string, value: unknown) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if (data.name !== undefined) set('name', data.name);
        if (data.email !== undefined) set('email', data.email);
        if (data.groups !== undefined) set('groups', JSON.stringify(data.groups));
        if (data.disabled !== undefined) set('disabled', data.disabled);
        if (data.mustChangePassword !== undefined) set('must_change_password', data.mustChangePassword);
        if (data.homeDir !== undefined) set('home_dir', data.homeDir);
        if (data.data !== undefined) set('data', JSON.stringify(data.data));
        if (data.lastLoginAt !== undefined) set('last_login_at', data.lastLoginAt);
        set('updated_at', Date.now());
        const { rows } = await this.pool.query(`UPDATE ${this.t.users} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
        if (!rows[0]) throw new Error(`User with id '${id}' not found`);
        return toUser(rows[0]);
    }

    async deleteUser(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.users} WHERE id = $1`, [id]);
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
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.groups} ORDER BY created_at, name`);
        return rows.map(toGroup);
    }

    async getGroup(name: string): Promise<Group | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.groups} WHERE lower(name) = lower($1)`, [name]);
        return rows[0] ? toGroup(rows[0]) : undefined;
    }

    async createGroup(data: CreateGroupDto): Promise<Group> {
        const now = Date.now();
        try {
            const { rows } = await this.pool.query(
                `INSERT INTO ${this.t.groups} (id, name, description, permissions, built_in, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
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
            sets.push(`description = $${values.length}`);
        }
        if (data.permissions !== undefined) {
            values.push(JSON.stringify(data.permissions));
            sets.push(`permissions = $${values.length}`);
        }
        values.push(Date.now());
        sets.push(`updated_at = $${values.length}`);
        const { rows } = await this.pool.query(`UPDATE ${this.t.groups} SET ${sets.join(', ')} WHERE lower(name) = lower($1) RETURNING *`, values);
        if (!rows[0]) throw new Error(`Group '${name}' not found`);
        return toGroup(rows[0]);
    }

    async deleteGroup(name: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.groups} WHERE lower(name) = lower($1)`, [name]);
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
            `INSERT INTO ${this.t.credentials} (user_id, password_hash, salt, last_changed) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, salt = EXCLUDED.salt, last_changed = EXCLUDED.last_changed`,
            [userId, hash, salt, Date.now()],
        );
    }

    async getCredentials(userId: string): Promise<Credentials | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.credentials} WHERE user_id = $1`, [userId]);
        const row = rows[0];
        return row ? { userId: row.user_id, passwordHash: row.password_hash, salt: row.salt, lastChanged: ms(row.last_changed) } : undefined;
    }

    async deleteCredentials(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.credentials} WHERE user_id = $1`, [userId]);
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
            `INSERT INTO ${this.t.sessions} (token_hash, id, user_id, created_at, last_activity, metadata) VALUES ($1, $2, $3, $4, $4, $5)
             ON CONFLICT (token_hash) DO UPDATE SET id = EXCLUDED.id, user_id = EXCLUDED.user_id, created_at = EXCLUDED.created_at,
                 last_activity = EXCLUDED.last_activity, metadata = EXCLUDED.metadata
             RETURNING *`,
            [tokenHash, randomUUID(), userId, now, JSON.stringify({ ...metadata })],
        );
        return toSession(rows[0]);
    }

    async getSession(tokenHash: string): Promise<Session | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.sessions} WHERE token_hash = $1`, [tokenHash]);
        return rows[0] ? toSession(rows[0]) : undefined;
    }

    async getSessionById(id: string): Promise<Session | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.sessions} WHERE id = $1`, [id]);
        return rows[0] ? toSession(rows[0]) : undefined;
    }

    async getActiveSessions(): Promise<Session[]> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.sessions} ORDER BY created_at`);
        return rows.map(toSession);
    }

    async deleteSession(tokenHash: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE token_hash = $1`, [tokenHash]);
    }

    async deleteSessionById(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE id = $1`, [id]);
    }

    async deleteUserSessions(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE user_id = $1`, [userId]);
    }

    async updateLastActivity(tokenHash: string): Promise<void> {
        await this.pool.query(`UPDATE ${this.t.sessions} SET last_activity = $2 WHERE token_hash = $1`, [tokenHash, Date.now()]);
    }

    async cleanup(maxAgeMs: number): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.sessions} WHERE last_activity < $1`, [Date.now() - maxAgeMs]);
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
            `INSERT INTO ${this.t.tokens} (id, user_id, name, token_hash, created_at, expires_at, last_used_at, audience, permissions)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, name = EXCLUDED.name, token_hash = EXCLUDED.token_hash,
                 created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, last_used_at = EXCLUDED.last_used_at,
                 audience = EXCLUDED.audience, permissions = EXCLUDED.permissions
             RETURNING *`,
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
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.tokens} WHERE token_hash = $1`, [tokenHash]);
        return rows[0] ? toToken(rows[0]) : undefined;
    }

    async getToken(id: string): Promise<ApiToken | undefined> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.tokens} WHERE id = $1`, [id]);
        return rows[0] ? toToken(rows[0]) : undefined;
    }

    async getTokens(userId?: string): Promise<ApiToken[]> {
        const { rows } =
            userId === undefined
                ? await this.pool.query(`SELECT * FROM ${this.t.tokens} ORDER BY created_at`)
                : await this.pool.query(`SELECT * FROM ${this.t.tokens} WHERE user_id = $1 ORDER BY created_at`, [userId]);
        return rows.map(toToken);
    }

    async deleteToken(id: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.tokens} WHERE id = $1`, [id]);
    }

    async deleteUserTokens(userId: string): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.tokens} WHERE user_id = $1`, [userId]);
    }

    async updateLastUsed(id: string, lastUsedAt: number): Promise<void> {
        await this.pool.query(`UPDATE ${this.t.tokens} SET last_used_at = $2 WHERE id = $1`, [id, lastUsedAt]);
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
        const stored: AuditEntry = { id: entry.id ?? randomUUID(), ...entry, timestamp: entry.timestamp ?? Date.now() };
        await this.pool.query(`INSERT INTO ${this.t.audit} (id, timestamp, event, username, actor, entry) VALUES ($1, $2, $3, $4, $5, $6)`, [
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
        if (options?.event) add('lower(event) = lower(?)', options.event);
        if (options?.username) add('lower(username) = lower(?)', options.username);
        if (options?.actor) add('lower(actor) = lower(?)', options.actor);
        if (options?.from) add('timestamp >= ?', options.from.getTime());
        if (options?.to) add('timestamp < ?', options.to.getTime());
        let sql = `SELECT entry FROM ${this.t.audit}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC`;
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
        const { rowCount } = await this.pool.query(`DELETE FROM ${this.t.audit} WHERE timestamp < $1`, [before.getTime()]);
        return rowCount ?? 0;
    }

    async clear(): Promise<void> {
        await this.pool.query(`DELETE FROM ${this.t.audit}`);
    }
}
