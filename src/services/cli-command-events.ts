import { CliEventPermissions, ICliEventBus } from '@qodalis/cli-server-abstractions';
import { ICliCommandRegistry } from './cli-command-registry';

/**
 * Publishes `command:executed` (audience `audit:read`) for a command run through the
 * REST execute, stream or MCP layer. Only the processor's name is sent, never the
 * arguments or input; unknown commands publish nothing.
 */
export async function publishCommandExecuted(
    eventBus: ICliEventBus | undefined,
    registry: ICliCommandRegistry,
    command: unknown,
    success: boolean,
    durationMs: number,
    userId?: string,
): Promise<void> {
    if (!eventBus || typeof command !== 'string') return;
    const processor = registry.findProcessor(command);
    if (!processor) return;
    await eventBus.publish(
        'command:executed',
        { command: processor.command, success, durationMs, ...(userId ? { userId } : {}) },
        { permission: CliEventPermissions.AuditRead },
    );
}
