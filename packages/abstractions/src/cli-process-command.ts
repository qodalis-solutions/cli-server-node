/** Parsed representation of a CLI command submitted for execution. */
export interface CliProcessCommand {
    /** Primary command keyword (e.g. "hash", "http"). */
    command: string;
    /** Optional payload data attached to the command. */
    data?: any;
    /** Sub-command chain following the primary command (e.g. ["encode"] for "base64 encode"). */
    chainCommands: string[];
    /** Original unparsed command string as entered by the user. */
    rawCommand: string;
    /** Positional value argument (the first non-flag token after the command). */
    value?: string;
    /**
     * The positional arguments after the command and sub-command words, split
     * like a shell: quotes removed, backslash escapes applied, flags excluded.
     * Sent by newer browsers; `value` stays as typed. Read it with `getPositionals`,
     * which falls back to splitting `value` when it is missing.
     */
    positionals?: string[];
    /** Named arguments parsed from flags (e.g. { algorithm: "sha256" }). */
    args: Record<string, any>;
}
