CREATE TABLE IF NOT EXISTS qcli_users (
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
CREATE UNIQUE INDEX IF NOT EXISTS qcli_users_name_key ON qcli_users (lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS qcli_users_email_key ON qcli_users (lower(email));
CREATE TABLE IF NOT EXISTS qcli_groups (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text,
    permissions jsonb NOT NULL DEFAULT '[]',
    built_in boolean NOT NULL DEFAULT false,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS qcli_groups_name_key ON qcli_groups (lower(name));
CREATE TABLE IF NOT EXISTS qcli_credentials (
    user_id text PRIMARY KEY,
    password_hash text NOT NULL,
    salt text NOT NULL,
    last_changed bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS qcli_sessions (
    token_hash text PRIMARY KEY,
    id text NOT NULL UNIQUE,
    user_id text NOT NULL,
    created_at bigint NOT NULL,
    last_activity bigint NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS qcli_sessions_user_idx ON qcli_sessions (user_id);
CREATE TABLE IF NOT EXISTS qcli_api_tokens (
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
CREATE INDEX IF NOT EXISTS qcli_api_tokens_user_idx ON qcli_api_tokens (user_id);
CREATE TABLE IF NOT EXISTS qcli_audit (
    seq bigserial PRIMARY KEY,
    id text NOT NULL,
    timestamp bigint NOT NULL,
    event text NOT NULL,
    username text,
    actor text,
    entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS qcli_audit_timestamp_idx ON qcli_audit (timestamp);