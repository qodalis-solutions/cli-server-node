/**
 * Which rows of a longer result a table output holds:
 * `{ "skip": 50, "take": 50, "total": 120, "hasMore": true }`.
 * `total` and `truncated` are omitted when not set.
 */
export interface CliTablePage {
    /** Rows skipped before the first row of the table. */
    skip: number;
    /** Rows asked for (the table may hold fewer). */
    take: number;
    /** All rows of the result, when the command knows it. */
    total?: number;
    /** Whether more rows follow (`--skip` = skip + rows shown). */
    hasMore: boolean;
    /**
     * Set when the server cut an unpaged table (the `maxTableRows` server option):
     * the command does not page, so `--skip` will not show the rest.
     */
    truncated?: boolean;
}

/** A single typed output block within a structured CLI response. */
export type CliStructuredOutput =
    | { type: 'text'; value: string; style?: 'success' | 'error' | 'info' | 'warning' }
    | {
          type: 'table';
          headers: string[];
          rows: string[][];
          /**
           * Which rows of a longer result these are, when the command pages (`--skip`, `--take`);
           * the terminal shows it under the table with the command for the next rows.
           */
          page?: CliTablePage;
      }
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
