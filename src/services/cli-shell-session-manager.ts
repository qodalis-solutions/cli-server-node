import { WebSocket } from 'ws';
import * as os from 'os';
import * as path from 'path';
import * as pty from 'node-pty';

type ClientMessage =
    | { type: 'stdin'; data: string }
    | { type: 'resize'; cols: number; rows: number };

type ServerMessage =
    | { type: 'stdout'; data: string }
    | { type: 'stderr'; data: string }
    | { type: 'exit'; code: number }
    | { type: 'error'; message: string }
    | { type: 'ready'; shell: string; os: string };

export class CliShellSessionManager {
    async handleSession(
        ws: WebSocket,
        cols: number,
        rows: number,
        command?: string,
    ): Promise<void> {
        const { shell, args } = this.getShellInfo(command);

        let ptyProcess: pty.IPty;
        try {
            ptyProcess = pty.spawn(shell, args, {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: os.homedir(),
                env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
            });
        } catch (err: any) {
            this.send(ws, { type: 'error', message: err.message });
            ws.close();
            return;
        }

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
            }
        });

        ws.on('close', () => {
            try {
                ptyProcess.kill();
            } catch {
                // Already exited
            }
        });

        ws.on('error', () => {
            try {
                ptyProcess.kill();
            } catch {
                // Already exited
            }
        });
    }

    private getShellInfo(command?: string): { shell: string; args: string[] } {
        if (os.platform() === 'win32') {
            const shell = 'powershell.exe';
            return command
                ? { shell, args: ['-Command', command] }
                : { shell, args: [] };
        }

        const shell = '/bin/bash';
        return command
            ? { shell, args: ['-c', command] }
            : { shell, args: [] };
    }

    private send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
}
