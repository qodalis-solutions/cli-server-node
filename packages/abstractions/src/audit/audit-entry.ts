/** Request details saved with an audit entry. Values must serialize to JSON. */
export interface AuditMetadata {
    /** The client address the request came from. */
    remoteAddress?: string;
    /** The session the request was made in, when known. */
    sessionId?: string;
    [key: string]: unknown;
}

/**
 * One entry of the audit log: who did what, to whom, when. Timestamps are epoch
 * milliseconds. Written by the users plugin (sign-ins, users, groups, tokens), by
 * the server (shell sessions) and by hosts recording their own changes.
 */
export interface AuditEntry {
    /** Assigned by the store when absent. */
    id?: string;
    timestamp: number;
    event: string;
    /** The user the event is about. */
    username: string;
    details?: string;
    /** Id of the user the event is about, when known. */
    userId?: string;
    /** The acting user, when different from / in addition to `username`. */
    actor?: string;
    /** Id of the acting user, when known. */
    actorId?: string;
    /**
     * What the event is about when it is not a user: a group (`group:admins`), a job,
     * or a host's own object such as a role or plan.
     */
    target?: string;
    /**
     * The host's own values for this entry (e.g. the old and new value of a setting),
     * saved with it and returned by the audit API. Values must serialize to JSON.
     */
    properties?: Record<string, unknown>;
    metadata?: AuditMetadata;
}
