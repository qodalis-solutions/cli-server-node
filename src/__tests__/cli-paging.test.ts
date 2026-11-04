/**
 * Paged tables and the row cap: CliPaging (--skip / --take), writePagedTable,
 * the table page JSON shape, maxTableRows on /execute, /execute/stream and MCP, and
 * the MCP page line.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import {
    CliCommandProcessor,
    CliPaging,
    CliProcessCommand,
    CliStructuredOutput,
    CliStructuredResponse,
    DEFAULT_TAKE,
    MAX_TAKE,
} from '../abstractions';
import { CliResponseBuilder } from '../services/cli-response-builder';
import { CliOutputLimits, DEFAULT_MAX_TABLE_ROWS } from '../services/cli-output-limits';
import { describePage, renderOutputsAsText } from '../mcp/mcp-render';
import { createCliServer, CliServerOptions } from '../create-cli-server';

function cmd(args: Record<string, any> = {}): CliProcessCommand {
    return { command: 'list', chainCommands: [], rawCommand: 'list', args };
}

function rows(count: number): string[][] {
    return Array.from({ length: count }, (_, i) => [String(i + 1)]);
}

function table(count: number): CliStructuredOutput {
    return { type: 'table', headers: ['N'], rows: rows(count) };
}

class TableProc extends CliCommandProcessor {
    description = 'returns a table';
    constructor(
        public command: string,
        private readonly output: CliStructuredOutput,
    ) {
        super();
    }
    async handleAsync(): Promise<string> {
        return '';
    }
    async handleStructuredAsync(): Promise<CliStructuredResponse> {
        return { exitCode: 0, outputs: [this.output] };
    }
}

function server(options: CliServerOptions = {}) {
    const builder = new CliResponseBuilder();
    builder.writePagedTable(['N'], rows(50), CliPaging.from(cmd({ skip: 50 })), { total: 1000 });
    return createCliServer({
        mcp: true,
        ...options,
        configure: (b) => {
            b.addProcessor(new TableProc('big', table(300)));
            b.addProcessor(new TableProc('small', table(10)));
            b.addProcessor(new TableProc('paged', builder.build().outputs[0]));
        },
    });
}

async function execute(app: any, command: string) {
    const res = await request(app).post('/api/v1/qcli/execute').send({ ...cmd(), command }).expect(200);
    return res.body as CliStructuredResponse;
}

function sseOutputs(text: string): any[] {
    return text
        .split('\n\n')
        .filter((b) => b.startsWith('event: output'))
        .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
}

describe('CliPaging.from', () => {
    it('defaults to skip 0, take 50', () => {
        expect(CliPaging.from(cmd())).toEqual({ skip: 0, take: 50 });
        expect(DEFAULT_TAKE).toBe(50);
        expect(MAX_TAKE).toBe(500);
    });

    it('reads numbers and strings', () => {
        expect(CliPaging.from(cmd({ skip: 40, take: 20 }))).toEqual({ skip: 40, take: 20 });
        expect(CliPaging.from(cmd({ skip: '25', take: '25' }))).toEqual({ skip: 25, take: 25 });
        expect(CliPaging.from(cmd({ skip: ' 7 ', take: '+3' }))).toEqual({ skip: 7, take: 3 });
    });

    it('caps take at 500', () => {
        expect(CliPaging.from(cmd({ take: 10000 })).take).toBe(500);
        expect(CliPaging.from(cmd({ take: '501' })).take).toBe(500);
        expect(CliPaging.from(cmd({ take: 500 })).take).toBe(500);
        expect(CliPaging.from(cmd({ take: 1 })).take).toBe(1);
    });

    it('lowers a negative skip to 0', () => {
        expect(CliPaging.from(cmd({ skip: -10 })).skip).toBe(0);
        expect(CliPaging.from(cmd({ skip: '-5' })).skip).toBe(0);
    });

    it('falls back to the default take for 0, negative or invalid values', () => {
        for (const bad of [0, -1, '0', '-3']) {
            expect(CliPaging.from(cmd({ take: bad })).take).toBe(50);
        }
    });

    it('falls back to the defaults for non-integer values', () => {
        for (const bad of ['abc', '', '2.5', 2.5, null, true, false, {}, NaN, Infinity]) {
            expect(CliPaging.from(cmd({ skip: bad, take: bad }))).toEqual({ skip: 0, take: 50 });
        }
    });

    it('uses the given default take', () => {
        expect(CliPaging.from(cmd(), 20)).toEqual({ skip: 0, take: 20 });
        expect(CliPaging.from(cmd({ take: 0 }), 20).take).toBe(20);
    });
});

describe('CliPaging.parameters', () => {
    it('declares skip and take as numbers with defaults', () => {
        const [skip, take] = CliPaging.parameters();
        expect(skip).toMatchObject({ name: 'skip', type: 'number', required: false, defaultValue: 0, description: 'Rows to skip' });
        expect(take).toMatchObject({ name: 'take', type: 'number', required: false, defaultValue: 50, description: 'Rows to show (at most 500)' });
        expect(CliPaging.parameters(20)[1].defaultValue).toBe(20);
    });
});

describe('writePagedTable', () => {
    function pageOf(build: (b: CliResponseBuilder) => void): any {
        const builder = new CliResponseBuilder();
        build(builder);
        return (builder.build().outputs[0] as any).page;
    }

    it('derives hasMore from the total', () => {
        const second = CliPaging.from(cmd({ skip: 50 }));
        expect(pageOf((b) => b.writePagedTable(['N'], rows(50), second, { total: 120 }))).toEqual({ skip: 50, take: 50, total: 120, hasMore: true });
        const last = CliPaging.from(cmd({ skip: 100 }));
        expect(pageOf((b) => b.writePagedTable(['N'], rows(20), last, { total: 120 })).hasMore).toBe(false);
    });

    it('has no more without a total unless hasMore says so', () => {
        const page = CliPaging.from(cmd());
        expect(pageOf((b) => b.writePagedTable(['N'], rows(50), page))).toEqual({ skip: 0, take: 50, hasMore: false });
        expect(pageOf((b) => b.writePagedTable(['N'], rows(50), page, { hasMore: true })).hasMore).toBe(true);
        expect(pageOf((b) => b.writePagedTable(['N'], rows(50), page, { total: 500, hasMore: false })).hasMore).toBe(false);
    });

    it('serializes the page, omitting total and truncated when not set', () => {
        const builder = new CliResponseBuilder();
        builder.writePagedTable(['Name'], [['a']], CliPaging.from(cmd({ skip: 50 })), { total: 120 });
        builder.writePagedTable(['Name'], [['a']], CliPaging.from(cmd({ skip: 100 })), { hasMore: true });
        builder.writeTable(['Name'], [['a']]);
        const json = JSON.parse(JSON.stringify(builder.build().outputs));
        expect(json[0]).toEqual({ type: 'table', headers: ['Name'], rows: [['a']], page: { skip: 50, take: 50, total: 120, hasMore: true } });
        expect(json[1].page).toEqual({ skip: 100, take: 50, hasMore: true });
        expect('page' in json[2]).toBe(false);
    });
});

describe('CliOutputLimits', () => {
    it('cuts a large unpaged table to the first rows and marks it truncated', () => {
        const cut = CliOutputLimits.apply(table(300), DEFAULT_MAX_TABLE_ROWS) as any;
        expect(cut.rows).toHaveLength(200);
        expect(cut.rows[199]).toEqual(['200']);
        expect(cut.page).toEqual({ skip: 0, take: 200, total: 300, hasMore: true, truncated: true });
    });

    it('leaves paged, small and non-table outputs alone, and 0 disables it', () => {
        const paged: CliStructuredOutput = { ...(table(300) as any), page: { skip: 0, take: 300, hasMore: false } };
        expect(CliOutputLimits.apply(paged, 200)).toBe(paged);
        const small = table(200);
        expect(CliOutputLimits.apply(small, 200)).toBe(small);
        const text: CliStructuredOutput = { type: 'text', value: 'x' };
        expect(CliOutputLimits.apply(text, 1)).toBe(text);
        const big = table(300);
        expect(CliOutputLimits.apply(big, 0)).toBe(big);
        const response = { exitCode: 0, outputs: [big] };
        expect(CliOutputLimits.applyResponse(response, 0)).toBe(response);
    });
});

describe('maxTableRows', () => {
    it('caps unpaged tables on /execute (default 200)', async () => {
        const { app } = server();
        const big = (await execute(app, 'big')).outputs[0] as any;
        expect(big.rows).toHaveLength(200);
        expect(big.page).toEqual({ skip: 0, take: 200, total: 300, hasMore: true, truncated: true });

        const small = (await execute(app, 'small')).outputs[0] as any;
        expect(small.rows).toHaveLength(10);
        expect(small.page).toBeUndefined();

        const paged = (await execute(app, 'paged')).outputs[0] as any;
        expect(paged.rows).toHaveLength(50);
        expect(paged.page).toEqual({ skip: 50, take: 50, total: 1000, hasMore: true });
    });

    it('can be changed or turned off', async () => {
        expect(((await execute(server({ maxTableRows: 100 }).app, 'big')).outputs[0] as any).rows).toHaveLength(100);
        const off = (await execute(server({ maxTableRows: 0 }).app, 'big')).outputs[0] as any;
        expect(off.rows).toHaveLength(300);
        expect(off.page).toBeUndefined();
    });

    it('caps streamed tables on /execute/stream', async () => {
        const { app } = server();
        const res = await request(app).post('/api/v1/qcli/execute/stream').send({ ...cmd(), command: 'big' }).expect(200);
        const [big] = sseOutputs(res.text);
        expect(big.rows).toHaveLength(200);
        expect(big.page).toEqual({ skip: 0, take: 200, total: 300, hasMore: true, truncated: true });

        const paged = await request(app).post('/api/v1/qcli/execute/stream').send({ ...cmd(), command: 'paged' }).expect(200);
        expect(sseOutputs(paged.text)[0].rows).toHaveLength(50);

        const off = await request(server({ maxTableRows: 0 }).app).post('/api/v1/qcli/execute/stream').send({ ...cmd(), command: 'big' });
        expect(sseOutputs(off.text)[0].rows).toHaveLength(300);
    });

    it('caps MCP command results and describes the page', async () => {
        const { app } = server();
        const call = async (name: string) => {
            const res = await request(app)
                .post('/api/qcli/mcp')
                .set('Content-Type', 'application/json')
                .set('Accept', 'application/json, text/event-stream')
                .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } });
            return res.body.result.content[0].text as string;
        };
        const big = (await call('big')).split('\n');
        expect(big).toHaveLength(1 + 200 + 1);
        expect(big[big.length - 1]).toBe('(first 200 of 300 rows; the command does not page, narrow it down to see the rest)');
        const paged = (await call('paged')).split('\n');
        expect(paged[paged.length - 1]).toBe('(rows 51-100 of 1000; next: skip=100)');
        expect((await call('small')).split('\n')).toHaveLength(11);
    });
});

describe('describePage', () => {
    it('shows the rows 1-based and the skip for the next ones', () => {
        expect(describePage({ skip: 50, take: 50, total: 120, hasMore: true }, 50)).toBe('(rows 51-100 of 120; next: skip=100)');
        expect(describePage({ skip: 50, take: 50, hasMore: true }, 50)).toBe('(rows 51-100; next: skip=100)');
        expect(describePage({ skip: 100, take: 50, total: 120, hasMore: false }, 20)).toBe('(rows 101-120 of 120)');
        expect(describePage({ skip: 0, take: 50, hasMore: false }, 3)).toBe('(rows 1-3)');
    });

    it('says when there are no rows', () => {
        expect(describePage({ skip: 200, take: 50, total: 120, hasMore: false }, 0)).toBe('(no rows at skip=200 of 120)');
        expect(describePage({ skip: 200, take: 50, hasMore: false }, 0)).toBe('(no rows at skip=200)');
    });

    it('describes a truncated table', () => {
        expect(describePage({ skip: 0, take: 200, total: 300, hasMore: true, truncated: true }, 200)).toBe(
            '(first 200 of 300 rows; the command does not page, narrow it down to see the rest)',
        );
    });

    it('is appended under paged tables only', () => {
        const text = renderOutputsAsText([
            { type: 'table', headers: ['A'], rows: [['1']], page: { skip: 100, take: 50, hasMore: false } },
            { type: 'table', headers: ['B'], rows: [['2']] },
        ]);
        expect(text).toBe('A\n1\n(rows 101-101)\nB\n2');
    });
});
