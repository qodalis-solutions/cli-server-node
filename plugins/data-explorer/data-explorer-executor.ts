import {
    DataExplorerAuditEntry,
    DataExplorerCaller,
    DataExplorerErrorCode,
    DataExplorerExecuteRequest,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerLanguage,
    DataExplorerOutputFormat,
    DataExplorerProviderOptions,
    DataExplorerSchemaResult,
    IDataExplorerProvider,
} from '@qodalis/cli-server-abstractions';
import { DataExplorerRegistry } from './data-explorer-registry';
import {
    applyColumnPolicy,
    DataExplorerRateLimiter,
    filterListing,
    ansiQuoteName,
    filterSchema,
    fixNameCase,
    isReadOnly,
    maskedColumnError,
    maskedResultError,
    missingPermissions,
    nameCaseHint,
    objectsError,
    readOnlyError,
} from './data-explorer-policy';

/** Writes an audit entry (the server's audit log); absent when the server keeps none. */
export type DataExplorerAuditSink = (entry: DataExplorerAuditEntry) => Promise<void>;

/** Options of the executor: where audit entries go (read on every query, so a later sign-in provider counts). */
export interface DataExplorerExecutorOptions {
    audit?: () => DataExplorerAuditSink | undefined;
    rateLimiter?: DataExplorerRateLimiter;
}

/** Longest query text kept in an audit entry. */
export const AUDIT_QUERY_MAX_LENGTH = 2000;

/** Most names whose case a query has fixed before it runs again (`DataExplorerProviderOptions.fixNameCase`). */
export const MAX_NAME_FIXES = 5;

/**
 * Executes data explorer queries: the source's permissions, rate limit, read-only rules,
 * allowed objects and masked columns first, then the provider with a timeout, then the row limit, column masking
 * and the audit entry.
 */
export class DataExplorerExecutor {
    private readonly rateLimiter: DataExplorerRateLimiter;

    constructor(
        private readonly registry: DataExplorerRegistry,
        private readonly options: DataExplorerExecutorOptions = {},
    ) {
        this.rateLimiter = options.rateLimiter ?? new DataExplorerRateLimiter();
    }

    /**
     * Execute a query against the named data source as `caller`.
     *
     * @param request - Contains the source name, query string, and optional parameters.
     * @param caller - Who runs it (permissions, rate limit, audit); absent for trusted code.
     * @returns The query result. Never throws; errors (and refusals, with `errorCode`) are in the result.
     */
    async executeAsync(request: DataExplorerExecuteRequest, caller?: DataExplorerCaller): Promise<DataExplorerResult> {
        const entry = this.registry.get(request.source);
        if (!entry) {
            return this.failure(request.source, undefined, `Unknown data source: '${request.source}'`, 0, 'unknown_source');
        }
        const { provider, options } = entry;
        const startTime = Date.now();

        const missing = missingPermissions(options.requiredPermissions, caller);
        if (missing.length) {
            return this.refuse(request, options, caller, `forbidden: missing permission ${missing.join(', ')}`, 'forbidden');
        }
        if (!this.rateLimiter.tryAcquire(options, caller)) {
            const limit = options.rateLimit!;
            return this.refuse(request, options, caller, `Too many queries: at most ${limit.maxQueries} per ${limit.windowSeconds} s`, 'rate_limited');
        }
        const timeoutMs = options.timeout ?? 30000;
        const readOnly = isReadOnly(options);
        let query = request.query;
        let result: DataExplorerResult;
        for (let fixes = 0; ; fixes++) {
            if (readOnly && !provider.readOnlyQueries) {
                const error = readOnlyError(options.language, query);
                if (error) return this.refuse(request, options, caller, error, 'read_only');
            }
            const objects = objectsError(options, query);
            if (objects) return this.refuse(request, options, caller, objects, 'object_not_allowed');
            const masked = maskedColumnError(options, query);
            if (masked) return this.refuse(request, options, caller, masked, 'masked_column');

            const abortController = new AbortController();
            const timer = setTimeout(() => abortController.abort(), timeoutMs);
            const context: DataExplorerExecutionContext = {
                query,
                parameters: request.parameters ?? {},
                options,
                signal: abortController.signal,
            };

            try {
                result = await provider.executeAsync(context);
                clearTimeout(timer);
                if (query !== request.query) result.executedQuery = query;

                // Enforce maxRows
                if (options.maxRows && result.rows.length > options.maxRows) {
                    result.rows = result.rows.slice(0, options.maxRows);
                    result.rowCount = result.rows.length;
                    result.truncated = true;
                }
                const maskedResult = result.success ? maskedResultError(options, query, result.columns) : undefined;
                if (maskedResult) {
                    // A masked column came back under another name: withhold the rows
                    result = this.failure(request.source, options, maskedResult, Date.now() - startTime, 'masked_column');
                } else if (result.success) {
                    filterListing(result, options, query);
                    applyColumnPolicy(result, options);
                }
            } catch (err: any) {
                clearTimeout(timer);
                const message = abortController.signal.aborted
                    ? `Query timed out after ${timeoutMs}ms`
                    : err.message ?? String(err);
                result = this.failure(request.source, options, message, Date.now() - startTime);
                if (abortController.signal.aborted) break;
            }
            // A missing table or column that the shown schema has with capitals (SQL sources answer
            // failures in the result or throw them)
            if (result.success || result.errorCode || !result.error || options.language !== DataExplorerLanguage.Sql) break;
            const schema = await this.visibleSchema(provider, options);
            // A read-only query changed nothing, so it runs again with the name's case fixed (one name per run)
            const fixed = readOnly && options.fixNameCase !== false && fixes < MAX_NAME_FIXES
                ? fixNameCase(query, result.error, schema, (name) => provider.quoteName?.(name) ?? ansiQuoteName(name))
                : undefined;
            if (fixed !== undefined) {
                query = fixed;
                continue;
            }
            const hint = nameCaseHint(result.error, schema);
            if (hint) result.error = `${result.error.trimEnd()}\n${hint}`;
            break;
        }
        this.audit(request, options, caller, result, Date.now() - startTime);
        return result;
    }

    /** The source's schema as its callers see it, or undefined when the provider cannot give one. */
    private async visibleSchema(
        provider: IDataExplorerProvider,
        options: DataExplorerProviderOptions,
    ): Promise<DataExplorerSchemaResult | undefined> {
        try {
            const schema = await provider.getSchemaAsync?.(options);
            return schema ? filterSchema(schema, options) : undefined;
        } catch {
            return undefined;
        }
    }

    private refuse(
        request: DataExplorerExecuteRequest,
        options: DataExplorerProviderOptions,
        caller: DataExplorerCaller | undefined,
        error: string,
        code: DataExplorerErrorCode,
    ): DataExplorerResult {
        const result = this.failure(request.source, options, error, 0, code);
        this.audit(request, options, caller, result, 0);
        return result;
    }

    private failure(
        source: string,
        options: DataExplorerProviderOptions | undefined,
        error: string,
        executionTime: number,
        errorCode?: DataExplorerErrorCode,
    ): DataExplorerResult {
        return {
            success: false,
            source,
            language: options?.language ?? DataExplorerLanguage.Sql,
            defaultOutputFormat: options?.defaultOutputFormat ?? DataExplorerOutputFormat.Table,
            executionTime,
            columns: null,
            rows: [],
            rowCount: 0,
            truncated: false,
            error,
            ...(errorCode ? { errorCode } : {}),
        };
    }

    /** Writes the `data_query` audit entry (never awaited: a failing audit log does not fail the query). */
    private audit(
        request: DataExplorerExecuteRequest,
        options: DataExplorerProviderOptions,
        caller: DataExplorerCaller | undefined,
        result: DataExplorerResult,
        durationMs: number,
    ): void {
        if (options.audit === false) return;
        const sink = this.options.audit?.();
        if (!sink) return;
        const truncate = (text: string) =>
            text.length > AUDIT_QUERY_MAX_LENGTH ? `${text.slice(0, AUDIT_QUERY_MAX_LENGTH)}…` : text;
        const query = truncate(request.query);
        sink({
            event: 'data_query',
            userId: caller?.userId ?? '',
            userName: caller?.userName ?? 'anonymous',
            metadata: {
                source: options.name,
                query,
                success: result.success,
                rowCount: result.rowCount,
                durationMs,
                ...(result.error ? { error: result.error } : {}),
                ...(result.executedQuery ? { executedQuery: truncate(result.executedQuery) } : {}),
                ...(caller?.remoteAddress ? { remoteAddress: caller.remoteAddress } : {}),
            },
        }).catch(() => undefined);
    }
}
