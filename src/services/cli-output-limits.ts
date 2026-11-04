import { CliServerOutput, CliServerResponse } from '../models';

/** The default `maxTableRows` server option: the most rows an unpaged table may return. */
export const DEFAULT_MAX_TABLE_ROWS = 200;

/** Caps unpaged tables at the `maxTableRows` server option. */
export const CliOutputLimits = {
    /**
     * `output`, or for a table without a page that has more than `maxRows` rows, a copy
     * with the first rows and a page marked truncated. `maxRows <= 0` disables the cap.
     */
    apply(output: CliServerOutput, maxRows: number): CliServerOutput {
        if (!(maxRows > 0) || output?.type !== 'table' || output.page || (output.rows?.length ?? 0) <= maxRows) {
            return output;
        }
        return {
            type: 'table',
            headers: output.headers,
            rows: output.rows.slice(0, maxRows),
            page: { skip: 0, take: maxRows, total: output.rows.length, hasMore: true, truncated: true },
        };
    },

    /** `response` with {@link CliOutputLimits.apply} applied to every output. */
    applyResponse(response: CliServerResponse, maxRows: number): CliServerResponse {
        if (!(maxRows > 0) || !Array.isArray(response?.outputs)) {
            return response;
        }
        return { ...response, outputs: response.outputs.map((o) => CliOutputLimits.apply(o, maxRows)) };
    },
};
