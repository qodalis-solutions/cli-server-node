import {
    CliEventAudience,
    CliEventHandler,
    ICliEventBus,
    cliEventPatternMatches,
    createCliEvent,
} from '@qodalis/cli-server-abstractions';
import { createLogger } from '../utils/logger';

const logger = createLogger('EventBus');

/**
 * The server's event bus (`createCliServer` creates one: `result.eventBus`). Handlers
 * run in subscription order; a handler that throws is logged and the others still run,
 * so publishing never fails the action that publishes.
 */
export class CliEventBus implements ICliEventBus {
    private readonly _handlers: Array<{ pattern: string; handler: CliEventHandler }> = [];
    /**
     * Set while a handler error is logged. A captured log line is an event too (`log:entry`),
     * so failures while logging, or while handling `log:*` events, are not logged again.
     */
    private _reporting = false;

    async publish(type: string, data?: Record<string, unknown>, audience?: CliEventAudience): Promise<void> {
        const event = createCliEvent(type, data, audience);
        for (const entry of [...this._handlers]) {
            if (!cliEventPatternMatches(type, entry.pattern)) continue;
            try {
                await entry.handler(event);
            } catch (err) {
                if (this._reporting || type.startsWith('log:')) continue;
                this._reporting = true;
                try {
                    logger.error('Handler of %s failed for %s: %s', entry.pattern, type, (err as Error)?.message ?? err);
                } finally {
                    this._reporting = false;
                }
            }
        }
    }

    subscribe(pattern: string, handler: CliEventHandler): () => void {
        const entry = { pattern, handler };
        this._handlers.push(entry);
        return () => {
            const i = this._handlers.indexOf(entry);
            if (i >= 0) this._handlers.splice(i, 1);
        };
    }
}
