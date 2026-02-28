export interface CliProcessCommand {
    command: string;
    data?: any;
    chainCommands: string[];
    rawCommand: string;
    value?: string;
    args: Record<string, any>;
}
