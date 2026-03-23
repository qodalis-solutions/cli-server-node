import { ICliJobLogger } from './cli-job-logger';

/** Context passed to a job during execution, providing access to logging. */
export interface ICliJobExecutionContext {
    /** Logger for recording job progress and diagnostics. */
    logger: ICliJobLogger;
}
