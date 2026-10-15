import { IFileStorageProvider } from '@qodalis/cli-server-plugin-filesystem';
import { CliServerPermissions as P } from '../../auth/cli-server-auth';
import { McpTool, McpToolProvider, mcpError, mcpJson, mcpObjectSchema } from '../mcp-types';

export const FS_READ_DEFAULT_MAX_BYTES = 262_144;

const errorMessage = (err: unknown) => (err as Error)?.message ?? String(err);

/** Reads at most `maxBytes` from the provider's download stream. */
async function readBytes(provider: IFileStorageProvider, path: string, maxBytes: number): Promise<Buffer> {
    const stream = await provider.getDownloadStream(path);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            chunks.push(buf);
            total += buf.length;
            if (total >= maxBytes) break;
        }
    } finally {
        (stream as { destroy?: () => void }).destroy?.();
    }
    const all = Buffer.concat(chunks);
    return all.length > maxBytes ? all.subarray(0, maxBytes) : all;
}

/** Drops an incomplete UTF-8 sequence at the end of a truncated buffer. */
function trimPartialUtf8(buf: Buffer): Buffer {
    let i = buf.length - 1;
    let continuation = 0;
    while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) {
        i--;
        continuation++;
    }
    if (i < 0) return buf;
    const lead = buf[i];
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    return expected > continuation + 1 ? buf.subarray(0, i) : buf;
}

/** Decodes UTF-8 text; undefined for binary content (NUL bytes or invalid UTF-8). */
function decodeText(buf: Buffer): string | undefined {
    if (buf.includes(0)) return undefined;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        return undefined;
    }
}

/**
 * Filesystem tools over the same storage provider (and path checks) as
 * `/api/qcli/fs`: `fs_list`, `fs_stat`, `fs_read` (`files:read`), `fs_write`,
 * `fs_mkdir`, `fs_delete` (`files:write`).
 */
export class FilesystemMcpToolProvider implements McpToolProvider {
    readonly name = 'filesystem';

    constructor(private readonly provider: IFileStorageProvider) {}

    getTools(): McpTool[] {
        const fs = this.provider;
        const pathProp = { path: { type: 'string' as const, description: 'File or directory path' } };
        const run = async (fn: () => Promise<ReturnType<typeof mcpJson>>) => {
            try {
                return await fn();
            } catch (err) {
                return mcpError(errorMessage(err));
            }
        };
        return [
            {
                name: 'fs_list',
                description: 'List the entries of a directory',
                inputSchema: mcpObjectSchema(pathProp, ['path']),
                requiredPermissions: [P.FilesRead],
                annotations: { readOnlyHint: true },
                call: (args) =>
                    run(async () => {
                        const entries = await fs.list(args.path as string);
                        const text = entries.map((e) => `${e.type === 'directory' ? 'd' : '-'} ${e.size}\t${e.modified}\t${e.name}`).join('\n');
                        return mcpJson({ entries }, text);
                    }),
            },
            {
                name: 'fs_stat',
                description: 'Metadata of a file or directory',
                inputSchema: mcpObjectSchema(pathProp, ['path']),
                requiredPermissions: [P.FilesRead],
                annotations: { readOnlyHint: true },
                call: (args) =>
                    run(async () => {
                        const stat = await fs.stat(args.path as string);
                        const text = Object.entries(stat).map(([k, v]) => `${k}: ${v}`).join('\n');
                        return mcpJson({ ...stat }, text);
                    }),
            },
            {
                name: 'fs_read',
                description: 'Read a UTF-8 text file (at most maxBytes bytes)',
                inputSchema: mcpObjectSchema(
                    {
                        ...pathProp,
                        maxBytes: { type: 'integer', description: 'Maximum bytes to read', default: FS_READ_DEFAULT_MAX_BYTES },
                    },
                    ['path'],
                ),
                requiredPermissions: [P.FilesRead],
                annotations: { readOnlyHint: true },
                call: (args) =>
                    run(async () => {
                        const path = args.path as string;
                        const maxBytes = (args.maxBytes as number | undefined) ?? FS_READ_DEFAULT_MAX_BYTES;
                        if (maxBytes < 1) return mcpError('maxBytes must be at least 1');
                        const stat = await fs.stat(path);
                        if (stat.type === 'directory') return mcpError(`${path} is a directory`);
                        const raw = await readBytes(fs, path, maxBytes);
                        const truncated = stat.size > raw.length;
                        const shown = truncated ? trimPartialUtf8(raw) : raw;
                        const text = decodeText(shown);
                        if (text === undefined) return mcpError(`binary file, ${stat.size} bytes`);
                        return {
                            text: truncated ? `${text}\n[truncated: ${shown.length} of ${stat.size} bytes]` : text,
                            isError: false,
                        };
                    }),
            },
            {
                name: 'fs_write',
                description: 'Create or overwrite a text file',
                inputSchema: mcpObjectSchema(
                    { ...pathProp, content: { type: 'string', description: 'UTF-8 file content' } },
                    ['path', 'content'],
                ),
                requiredPermissions: [P.FilesWrite],
                call: (args) =>
                    run(async () => {
                        const content = args.content as string;
                        await fs.writeFile(args.path as string, content);
                        const bytes = Buffer.byteLength(content, 'utf8');
                        return mcpJson({ path: args.path, bytes }, `Wrote ${bytes} bytes to ${args.path}`);
                    }),
            },
            {
                name: 'fs_mkdir',
                description: 'Create a directory (and missing parents)',
                inputSchema: mcpObjectSchema(pathProp, ['path']),
                requiredPermissions: [P.FilesWrite],
                call: (args) =>
                    run(async () => {
                        await fs.mkdir(args.path as string, true);
                        return mcpJson({ path: args.path }, `Created ${args.path}`);
                    }),
            },
            {
                name: 'fs_delete',
                description: 'Delete a file or directory (recursive for non-empty directories)',
                inputSchema: mcpObjectSchema(
                    { ...pathProp, recursive: { type: 'boolean', description: 'Delete non-empty directories', default: false } },
                    ['path'],
                ),
                requiredPermissions: [P.FilesWrite],
                annotations: { destructiveHint: true },
                call: (args) =>
                    run(async () => {
                        await fs.remove(args.path as string, (args.recursive as boolean | undefined) ?? false);
                        return mcpJson({ deleted: args.path }, `Deleted ${args.path}`);
                    }),
            },
        ];
    }
}
