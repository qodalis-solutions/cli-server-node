import { ICliJob, ICliJobExecutionContext } from '@qodalis/cli-server-abstractions';

export class SampleHealthCheckJob implements ICliJob {
    async executeAsync(context: ICliJobExecutionContext, signal: AbortSignal): Promise<void> {
        context.logger.info('Running health check...');

        await new Promise((resolve) => setTimeout(resolve, 500));

        if (signal.aborted) return;

        context.logger.info('Health check passed');
    }
}
