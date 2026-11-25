/**
 * The docs plugin's `docs` terminal command through POST /execute: list (grouped, --group, --json), read (markdown
 * with variables, --json, heading from the title), no pages, unknown or missing slugs, and a protected server
 * (no permission beyond commands:execute, like the public pages).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createCliServer, CliServerResult } from '../create-cli-server';
import { CliDocsBuilder } from '@qodalis/cli-server-plugin-docs';
import { protect, runCommand, subPermissions } from './command-test-helpers';

const disposables: Array<() => void> = [];
afterEach(() => {
    while (disposables.length) disposables.pop()!();
});

function start(configure: (b: CliDocsBuilder) => void = (b) => withPages(b)): CliServerResult {
    const builder = new CliDocsBuilder().setName('RateBell API').setVariable('support', 'help@ratebell.app');
    configure(builder);
    const cli = createCliServer();
    cli.mountPlugin(builder.build());
    disposables.push(() => {
        cli.eventSocketManager.dispose();
        cli.logSocketManager.dispose();
    });
    return cli;
}

function withPages(b: CliDocsBuilder): CliDocsBuilder {
    return b
        .addPage('intro', '---\ntitle: Welcome to {{name}}\norder: 1\n---\nWrite to {{support}}. API at {{baseUrl}}/api.')
        .addPage('auth', '---\ntitle: Authentication\norder: 2\n---\n# Sign in\n\nUse a token.')
        .addPage('limits', '---\ntitle: Rate limits\ngroup: Reference\norder: 10\n---\n')
        .addPage('errors', '---\ntitle: Errors\ngroup: Reference\norder: 10\n---\n{{unknown}} stays.');
}

describe('docs command', () => {
    it('is registered with list and read, needing no permission beyond commands:execute', () => {
        const cli = start();
        expect(cli.registry.findProcessor('docs')!.requiredPermissions).toBeUndefined();
        expect(subPermissions(cli, 'docs')).toEqual({ list: undefined, read: undefined });
    });

    it('docs and docs list: the pages by group, slug and title with variables replaced', async () => {
        const cli = start();
        const expected = ['Guides', '  intro   Welcome to RateBell API', '  auth    Authentication', '', 'Reference', '  errors  Errors', '  limits  Rate limits'].join('\n');
        expect((await runCommand(cli, 'docs')).text).toBe(expected);
        expect((await runCommand(cli, 'docs list')).text).toBe(expected);
        expect((await runCommand(cli, 'docs ls')).text).toBe(expected);
    });

    it('docs list --group filters (case-insensitive) and --json prints the list', async () => {
        const cli = start();
        expect((await runCommand(cli, 'docs list --group reference')).text).toBe('Reference\n  errors  Errors\n  limits  Rate limits');
        expect((await runCommand(cli, 'docs list --group Nope')).text).toBe('No documentation pages in the group Nope.');
        expect((await runCommand(cli, 'docs list --group')).text).toBe('Error: --group needs a group name');
        const json = JSON.parse((await runCommand(cli, 'docs list --json')).text);
        expect(json[0]).toEqual({ slug: 'intro', title: 'Welcome to RateBell API', group: 'Guides', order: 1 });
        expect(json).toHaveLength(4);
    });

    it('lists a group once even when its pages are not next to each other in page order', async () => {
        const cli = start((b) =>
            b.addPage('a', '---\ntitle: A\norder: 1\n---\n').addPage('b', '---\ntitle: B\ngroup: Other\norder: 2\n---\n').addPage('c', '---\ntitle: C\norder: 3\n---\n'),
        );
        expect((await runCommand(cli, 'docs')).text).toBe('Guides\n  a  A\n  c  C\n\nOther\n  b  B');
    });

    it('says so when there are no pages', async () => {
        const cli = start(() => undefined);
        expect((await runCommand(cli, 'docs')).text).toBe('No documentation pages.');
        expect((await runCommand(cli, 'docs list --json')).text).toBe('[]');
    });

    it('docs read: the markdown with variables, the title as a heading unless the page has its own', async () => {
        const cli = start();
        expect((await runCommand(cli, 'docs read intro')).text).toBe('# Welcome to RateBell API\n\nWrite to help@ratebell.app. API at /api.');
        expect((await runCommand(cli, 'docs read auth')).text).toBe('# Sign in\n\nUse a token.');
        expect((await runCommand(cli, 'docs read limits')).text).toBe('# Rate limits');
        expect((await runCommand(cli, 'docs show errors')).text).toBe('# Errors\n\n{{unknown}} stays.');
    });

    it('docs read uses the configured base URL', async () => {
        const cli = start((b) => withPages(b).setBaseUrl('https://api.example.com/'));
        expect((await runCommand(cli, 'docs read intro')).text).toContain('API at https://api.example.com/api.');
    });

    it('docs read --json: the page as GET /pages/:slug serves it', async () => {
        const cli = start();
        expect(JSON.parse((await runCommand(cli, 'docs read intro --json')).text)).toEqual({
            slug: 'intro',
            title: 'Welcome to RateBell API',
            group: 'Guides',
            order: 1,
            markdown: 'Write to help@ratebell.app. API at /api.',
        });
    });

    it('docs read: missing, unknown or several slugs', async () => {
        const cli = start();
        expect((await runCommand(cli, 'docs read')).text).toBe('Error: name the page: docs read <slug> (docs list shows them)');
        expect((await runCommand(cli, 'docs read nope')).text).toBe('Error: page not found: nope (docs list shows the pages)');
        expect((await runCommand(cli, 'docs read intro auth')).text).toBe('Error: one page at a time: docs read <slug>');
    });

    it('on a protected server: signed in with commands:execute is enough, anonymous is refused', async () => {
        const cli = start();
        const { plugin, tokens } = await protect(cli, { runner: ['commands:execute'] });
        disposables.push(() => plugin.dispose());
        expect((await runCommand(cli, 'docs list')).status).toBe(401);
        expect((await runCommand(cli, 'docs read auth', tokens.runner)).text).toBe('# Sign in\n\nUse a token.');
    });
});
