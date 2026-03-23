import { ICliJobExecutionContext, ICliJobLogger } from '@qodalis/cli-server-abstractions';
import { CliJobLogger } from './cli-job-logger';

/** Concrete execution context provided to each job run, wrapping a logger for capturing output. */
export class CliJobExecutionContext implements ICliJobExecutionContext {
    readonly logger: ICliJobLogger;

    private readonly _jobLogger: CliJobLogger;

    constructor() {
        this._jobLogger = new CliJobLogger();
        this.logger = this._jobLogger;
    }

    /** Returns the collected log entries from the job execution. */
    get logEntries() {
        return this._jobLogger.entries;
    }
}
