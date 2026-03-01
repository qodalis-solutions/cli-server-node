import { describe, it, expect, beforeEach } from 'vitest';
import { CliResponseBuilder } from '../services/cli-response-builder';

describe('CliResponseBuilder', () => {
    let builder: CliResponseBuilder;

    beforeEach(() => {
        builder = new CliResponseBuilder();
    });

    it('should add text output', () => {
        builder.writeText('hello');
        const response = builder.build();

        expect(response.outputs).toHaveLength(1);
        expect(response.outputs[0]).toEqual({ type: 'text', value: 'hello' });
    });

    it('should add text output with style', () => {
        builder.writeText('error!', 'error');
        const response = builder.build();

        expect(response.outputs[0]).toEqual({ type: 'text', value: 'error!', style: 'error' });
    });

    it('should add table output', () => {
        builder.writeTable(['Name', 'Value'], [['a', '1'], ['b', '2']]);
        const response = builder.build();

        expect(response.outputs).toHaveLength(1);
        expect(response.outputs[0]).toEqual({
            type: 'table',
            headers: ['Name', 'Value'],
            rows: [['a', '1'], ['b', '2']],
        });
    });

    it('should add list output', () => {
        builder.writeList(['item1', 'item2']);
        const response = builder.build();

        expect(response.outputs[0]).toEqual({
            type: 'list',
            items: ['item1', 'item2'],
            ordered: false,
        });
    });

    it('should add ordered list output', () => {
        builder.writeList(['first', 'second'], true);
        const response = builder.build();

        expect(response.outputs[0]).toEqual({
            type: 'list',
            items: ['first', 'second'],
            ordered: true,
        });
    });

    it('should add json output', () => {
        const value = { key: 'val', nested: { a: 1 } };
        builder.writeJson(value);
        const response = builder.build();

        expect(response.outputs[0]).toEqual({ type: 'json', value });
    });

    it('should add key-value output', () => {
        builder.writeKeyValue({ name: 'test', version: '1.0.0' });
        const response = builder.build();

        expect(response.outputs[0]).toEqual({
            type: 'key-value',
            entries: [
                { key: 'name', value: 'test' },
                { key: 'version', value: '1.0.0' },
            ],
        });
    });

    it('should set exit code', () => {
        builder.setExitCode(42);
        const response = builder.build();

        expect(response.exitCode).toBe(42);
    });

    it('should default exit code to 0', () => {
        const response = builder.build();
        expect(response.exitCode).toBe(0);
    });

    it('should build correct response shape with multiple outputs', () => {
        builder.writeText('starting');
        builder.writeJson({ status: 'ok' });
        builder.writeText('done', 'success');
        builder.setExitCode(0);

        const response = builder.build();

        expect(response).toEqual({
            exitCode: 0,
            outputs: [
                { type: 'text', value: 'starting' },
                { type: 'json', value: { status: 'ok' } },
                { type: 'text', value: 'done', style: 'success' },
            ],
        });
    });
});
