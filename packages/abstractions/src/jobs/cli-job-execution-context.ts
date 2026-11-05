import { ICliJobLogger } from './cli-job-logger';

/** Context passed to a job during execution. */
export interface ICliJobExecutionContext {
    /** Logger for recording job progress and diagnostics. */
    logger: ICliJobLogger;
    /**
     * The execution's own values ({@link JobExecution.properties}), e.g.
     * `context.properties.items = 32`; saved when the run ends, whatever its outcome,
     * and returned by the jobs API. Values must serialize to JSON.
     */
    properties: Record<string, unknown>;
    /**
     * Leaves this run out of the history when it completes: for a frequent job whose
     * run found nothing to do (e.g. no digest was due). The job's last run is still
     * updated. Failed runs are always kept.
     */
    discard(): void;
}
