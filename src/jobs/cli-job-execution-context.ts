import { ICliJobExecutionContext, ICliJobLogger } from '@qodalis/cli-server-abstractions';
import { CliJobLogger } from './cli-job-logger';

export class CliJobExecutionContext implements ICliJobExecutionContext {
    readonly logger: ICliJobLogger;

    private readonly _jobLogger: CliJobLogger;

    constructor() {
        this._jobLogger = new CliJobLogger();
        this.logger = this._jobLogger;
    }

    get logEntries() {
        return this._jobLogger.entries;
    }
}
