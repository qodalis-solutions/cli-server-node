import { CliProcessCommand } from './cli-process-command';
import { CliCommandParameterDescriptor, ICliCommandParameterDescriptor } from './cli-command-parameter-descriptor';

/** Rows to show when the command line does not say (`--take`). */
export const DEFAULT_TAKE = 50;

/** The largest `--take` accepted; larger values are lowered to it. */
export const MAX_TAKE = 500;

/**
 * The rows a list command was asked for, read from `--skip` and `--take`. Commands
 * that can return many rows declare {@link CliPaging.parameters}, read the request
 * with {@link CliPaging.from}, query with `skip` and `take`, and write the rows with
 * `writePagedTable` so the terminal shows which rows these are and how to get the next ones.
 */
export interface CliPageRequest {
    /** Rows to skip before the first one shown (0 = from the start). */
    skip: number;
    /** Rows to show (1 to {@link MAX_TAKE}). */
    take: number;
}

/** The `--skip` / `--take` convention shared by list commands. */
export class CliPaging {
    private constructor() {}

    /**
     * The `--skip` and `--take` parameters, to add to a command's `parameters`
     * so help and completion show them.
     */
    static parameters(defaultTake: number = DEFAULT_TAKE): ICliCommandParameterDescriptor[] {
        return [
            new CliCommandParameterDescriptor('skip', 'Rows to skip', false, 'number', undefined, 0),
            new CliCommandParameterDescriptor(
                'take',
                `Rows to show (at most ${MAX_TAKE})`,
                false,
                'number',
                undefined,
                defaultTake,
            ),
        ];
    }

    /**
     * The rows asked for by `command`: `--skip` (default 0; negative values become 0) and
     * `--take` (default `defaultTake`, at most {@link MAX_TAKE}; 0, negative or invalid values
     * fall back to the default). Values may be numbers or strings; non-integers fall back to
     * the defaults.
     */
    static from(command: CliProcessCommand, defaultTake: number = DEFAULT_TAKE): CliPageRequest {
        const skip = Math.max(readInteger(command, 'skip') ?? 0, 0);
        const requested = readInteger(command, 'take');
        const take = Math.min(requested !== undefined && requested > 0 ? requested : defaultTake, MAX_TAKE);
        return { skip, take };
    }
}

function readInteger(command: CliProcessCommand, name: string): number | undefined {
    const value = command?.args?.[name];
    let number: number | undefined;
    if (typeof value === 'number') {
        number = value;
    } else if (typeof value === 'string' && /^\s*[+-]?\d+\s*$/.test(value)) {
        number = Number(value.trim());
    }
    return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}
