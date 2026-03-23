/** A single typed output block within a structured CLI response. */
export type CliStructuredOutput =
    | { type: 'text'; value: string; style?: 'success' | 'error' | 'info' | 'warning' }
    | { type: 'table'; headers: string[]; rows: string[][] }
    | { type: 'list'; items: string[]; ordered?: boolean }
    | { type: 'json'; value: any }
    | { type: 'key-value'; entries: { key: string; value: string }[] };

/** Response envelope returned by structured command execution, containing an exit code and typed outputs. */
export interface CliStructuredResponse {
    /** Process exit code (0 for success, non-zero for errors). */
    exitCode: number;
    /** Ordered list of typed output blocks. */
    outputs: CliStructuredOutput[];
}
