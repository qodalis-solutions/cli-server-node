/**
 * Simple structured logger with category prefixes.
 */
export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

export function createLogger(category: string): Logger {
    const prefix = `[${category}]`;
    return {
        debug: (msg, ...args) => console.debug(`${prefix} ${msg}`, ...args),
        info: (msg, ...args) => console.log(`${prefix} ${msg}`, ...args),
        warn: (msg, ...args) => console.warn(`${prefix} ${msg}`, ...args),
        error: (msg, ...args) => console.error(`${prefix} ${msg}`, ...args),
    };
}
