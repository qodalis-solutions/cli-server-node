import { ICliJobExecutionContext } from './cli-job-execution-context';

export interface ICliJob {
    executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void>;
}
