import { ICliJob, ICliJobExecutionContext } from '@qodalis/cli-server-abstractions';

/** Id and name of the built-in job that prunes the job history. */
export const HISTORY_PRUNE_JOB_ID = 'jobs:prune-history';

/**
 * The built-in `jobs:prune-history` job: deletes the runs past the history retention and
 * records how many in the run's `deleted` property.
 */
export class JobHistoryPruneJob implements ICliJob {
    constructor(private readonly prune: () => Promise<number>) {}

    async executeAsync(context: ICliJobExecutionContext): Promise<void> {
        const deleted = await this.prune();
        context.properties.deleted = deleted;
        context.logger.info(`Deleted ${deleted} job execution${deleted === 1 ? '' : 's'} past the history retention`);
    }
}
