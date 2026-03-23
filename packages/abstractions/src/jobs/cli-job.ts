import { ICliJobExecutionContext } from './cli-job-execution-context';

/** A scheduled or on-demand background job. */
export interface ICliJob {
    /**
     * Executes the job's work.
     * @param context - Execution context providing a logger.
     * @param signal - Abort signal for cancellation and timeout.
     */
    executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void>;
}
