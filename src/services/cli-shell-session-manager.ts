import { WebSocket } from 'ws';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('ShellSession');

/**
 * Lazy-loads node-pty to avoid import failures when the native add-on is unavailable.
 * @throws {Error} If node-pty cannot be loaded.
 */
let _pty: typeof import('node-pty') | undefined;
function getPty(): typeof import('node-pty') {
    if (!_pty) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            _pty = require('node-pty');
        } catch (err: any) {
            throw new Error(
                `node-pty is required for shell sessions but failed to load: ${err.message}`,
            );
        }
    }
    return _pty!;
}

/** Messages sent from the WebSocket client to the shell session. */
type ClientMessage =
    | { type: 'stdin'; data: string }
    | { type: 'resize'; cols: number; rows: number };

/** Messages sent from the shell session to the WebSocket client. */
type ServerMessage =
    | { type: 'stdout'; data: string }
    | { type: 'stderr'; data: string }
    | { type: 'exit'; code: number }
    | { type: 'error'; message: string }
    | { type: 'ready'; shell: string; os: string };

/** Manages interactive PTY shell sessions over WebSocket connections. */
export class CliShellSessionManager {
    /**
     * Creates a PTY shell session bridged to the given WebSocket.
     * @param ws - WebSocket connection for the shell session.
     * @param cols - Initial terminal width in columns.
     * @param rows - Initial terminal height in rows.
     * @param command - Optional command to execute instead of an interactive shell.
     */
    async handleSession(
        ws: WebSocket,
        cols: number,
        rows: number,
        command?: string,
    ): Promise<void> {
        const { shell, args } = this.getShellInfo(command);

        let nodePty: typeof import('node-pty');
        try {
            nodePty = getPty();
        } catch (err: any) {
            logger.error('node-pty unavailable: %s', err.message ?? err);
            this.send(ws, { type: 'error', message: err.message });
            ws.close();
            return;
        }

        let ptyProcess: import('node-pty').IPty;
        try {
            ptyProcess = nodePty.spawn(shell, args, {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: os.homedir(),
                env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
            });
        } catch (err: any) {
            logger.error('Shell session error: %s', err.message ?? err);
            this.send(ws, { type: 'error', message: err.message });
            ws.close();
            return;
        }

        logger.info('Shell session started (shell=%s, cols=%d, rows=%d)', shell, cols, rows);

        const detectedOs = os.platform() === 'win32'
            ? 'win32'
            : os.platform() === 'darwin'
                ? 'darwin'
                : 'linux';

        this.send(ws, {
            type: 'ready',
            shell: path.basename(shell),
            os: detectedOs,
        });

        ptyProcess.onData((data) => {
            this.send(ws, { type: 'stdout', data });
        });

        ptyProcess.onExit(({ exitCode }) => {
            logger.info('Shell session ended');
            this.send(ws, { type: 'exit', code: exitCode });
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString()) as ClientMessage;
                switch (msg.type) {
                    case 'stdin':
                        ptyProcess.write(msg.data);
                        break;
                    case 'resize':
                        ptyProcess.resize(msg.cols, msg.rows);
                        break;
                }
            } catch {
                // Ignore malformed messages
                logger.debug('Ignoring malformed WebSocket message');
            }
        });

        ws.on('close', () => {
            try {
                ptyProcess.kill();
            } catch {
                // Already exited
                logger.debug('Process already exited, cleanup skipped');
            }
        });

        ws.on('error', (error) => {
            logger.error('Shell session error: %s', (error as Error).message ?? error);
            try {
                ptyProcess.kill();
            } catch {
                // Already exited
                logger.debug('Process already exited, cleanup skipped');
            }
        });
    }

    /** Determines the shell binary and arguments based on the platform and optional command. */
    private getShellInfo(command?: string): { shell: string; args: string[] } {
        if (os.platform() === 'win32') {
            const shell = 'powershell.exe';
            return command
                ? { shell, args: ['-Command', command] }
                : { shell, args: [] };
        }

        const shell = this.detectShell();
        return command
            ? { shell, args: ['-c', command] }
            : { shell, args: [] };
    }

    /** Detects the best available shell on Unix systems by checking $SHELL and common paths. */
    private detectShell(): string {
        const envShell = process.env.SHELL;
        if (envShell) {
            try {
                require('fs').accessSync(envShell, require('fs').constants.X_OK);
                return envShell;
            } catch {
                // $SHELL binary not accessible; try common paths
            }
        }

        const candidates = ['/bin/bash', '/usr/bin/bash', '/bin/sh'];
        for (const candidate of candidates) {
            try {
                require('fs').accessSync(candidate, require('fs').constants.X_OK);
                return candidate;
            } catch {
                continue;
            }
        }

        return '/bin/sh';
    }

    /** Sends a JSON message to the WebSocket if the connection is open. */
    private send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
}
