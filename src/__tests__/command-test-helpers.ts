/**
 * Shared helpers for terminal-command tests: run a command line through POST /api/v1/qcli/execute the way the web
 * terminal sends it, and set up a protected server with users holding chosen permissions.
 */
import request from 'supertest';
import { commandMatches, splitShellWords, type ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import type { CliServerResult } from '../create-cli-server';
import { CliUsersBuilder, type UsersPluginResult } from '../../plugins/users/index';

export const V1 = '/api/v1/qcli';
export const ROOT_PASS = 'rootpass1';

export interface CommandResult {
    status: number;
    /** The text outputs joined by new lines. */
    text: string;
    exitCode?: number;
    body: any;
}

/**
 * Runs a command line as the browser sends it: the sub-commands the registry knows become `chainCommands`, the
 * other words positionals (and `value`), `--name value` / `-n value` args, a lone `--flag` true.
 */
export async function runCommand(cli: CliServerResult, line: string, token?: string): Promise<CommandResult> {
    const [command, ...words] = splitShellWords(line);
    const chainCommands: string[] = [];
    const positionals: string[] = [];
    const args: Record<string, unknown> = {};
    let processor: ICliCommandProcessor | undefined = cli.registry.findProcessor(command);
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const flag = /^--?([A-Za-z][\w-]*)$/.exec(w);
        if (flag) {
            const next = words[i + 1];
            if (next !== undefined && !/^--?[A-Za-z]/.test(next)) {
                args[flag[1]] = next;
                i++;
            } else {
                args[flag[1]] = true;
            }
            continue;
        }
        const sub = positionals.length === 0 ? processor?.processors?.find((p) => commandMatches(p, w)) : undefined;
        if (sub) {
            chainCommands.push(w);
            processor = sub;
        } else {
            positionals.push(w);
        }
    }
    const req = request(cli.app).post(`${V1}/execute`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    const res = await req.send({ command, chainCommands, rawCommand: line, value: positionals.join(' ') || undefined, positionals, args });
    // text outputs as they are, structured ones (tables, key-value, json) as JSON
    const text = (res.body?.outputs ?? []).map((o: any) => (typeof o.value === 'string' ? o.value : JSON.stringify(o))).join('\n');
    return { status: res.status, text, exitCode: res.body?.exitCode, body: res.body };
}

/** The sub-commands of a registered command and their permissions, `{ list: ['x:read'], ... }`. */
export function subPermissions(cli: CliServerResult, command: string): Record<string, string[] | undefined> {
    const processor = cli.registry.findProcessor(command)!;
    return Object.fromEntries((processor.processors ?? []).map((p) => [p.command, p.requiredPermissions]));
}

/**
 * Mounts the users plugin (root's password {@link ROOT_PASS}) and creates one user per entry of `users`, each in
 * its own group with those permissions; returns the plugin and a session token per user name (and `root`).
 */
export async function protect(cli: CliServerResult, users: Record<string, string[]>): Promise<{ plugin: UsersPluginResult; tokens: Record<string, string> }> {
    const plugin = new CliUsersBuilder().setDefaultAdminPassword(ROOT_PASS).setIpRateLimit(10_000).setMinPasswordLength(4).build();
    await plugin.ready;
    cli.mountPlugin(plugin);
    const login = async (username: string, password: string) => (await request(cli.app).post(`${V1}/sessions`).send({ username, password })).body.token as string;
    const tokens: Record<string, string> = { root: await login('root', ROOT_PASS) };
    for (const [name, permissions] of Object.entries(users)) {
        await request(cli.app).post(`${V1}/groups`).set('Authorization', `Bearer ${tokens.root}`).send({ name: `${name}s`, permissions }).expect(201);
        await request(cli.app)
            .post(`${V1}/users`)
            .set('Authorization', `Bearer ${tokens.root}`)
            .send({ name, email: `${name}@x.io`, password: `${name}pass`, groups: [`${name}s`] })
            .expect(201);
        tokens[name] = await login(name, `${name}pass`);
    }
    return { plugin, tokens };
}
