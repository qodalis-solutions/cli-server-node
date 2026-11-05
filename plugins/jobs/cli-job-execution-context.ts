import { ICliJobExecutionContext, ICliJobLogger } from '@qodalis/cli-server-abstractions';
import { CliJobLogger } from './cli-job-logger';

/** Concrete execution context provided to each job run, wrapping a logger for capturing output. */
export class CliJobExecutionContext implements ICliJobExecutionContext {
    readonly logger: ICliJobLogger;
    readonly properties: Record<string, unknown> = {};

    private readonly _jobLogger: CliJobLogger;
    private _discarded = false;

    constructor() {
        this._jobLogger = new CliJobLogger();
        this.logger = this._jobLogger;
    }

    /** Leaves this run out of the history when it completes (failed runs are kept). */
    discard(): void {
        this._discarded = true;
    }

    /** Whether the job asked to leave this run out of the history. */
    get discarded(): boolean {
        return this._discarded;
    }

    /** Returns the collected log entries from the job execution. */
    get logEntries() {
        return this._jobLogger.entries;
    }
}
