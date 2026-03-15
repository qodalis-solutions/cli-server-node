import { ICliJobLogger, JobLogEntry, JobLogLevel } from '@qodalis/cli-server-abstractions';

export class CliJobLogger implements ICliJobLogger {
    private readonly _entries: JobLogEntry[] = [];

    debug(message: string): void {
        this._log('debug', message);
    }

    info(message: string): void {
        this._log('info', message);
    }

    warning(message: string): void {
        this._log('warning', message);
    }

    error(message: string): void {
        this._log('error', message);
    }

    get entries(): JobLogEntry[] {
        return this._entries;
    }

    private _log(level: JobLogLevel, message: string): void {
        this._entries.push({
            timestamp: new Date().toISOString(),
            level,
            message,
        });
    }
}
