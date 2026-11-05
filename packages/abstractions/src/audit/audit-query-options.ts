/** Filters and paging of an audit log query; filters are exact and case-insensitive. */
export interface AuditQueryOptions {
    /** The most entries to return. */
    limit?: number;
    /** Entries to skip, for paging (newest first). */
    offset?: number;
    /** The event name. */
    event?: string;
    /** The user the events are about. */
    username?: string;
    /** The user who performed the actions. */
    actor?: string;
    /** Only entries recorded at or after this time (inclusive). */
    from?: Date;
    /** Only entries recorded before this time (exclusive). */
    to?: Date;
}
