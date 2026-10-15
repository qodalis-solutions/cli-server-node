import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { CliServerAuthContext, ICliServerAuth, isOriginAllowed, isSameOrigin } from '../auth/cli-server-auth';
import { createLogger } from '../utils/logger';
import { version as PACKAGE_VERSION } from '../../package.json';
import { McpTool, McpToolProvider, McpToolResult, MCP_TOOL_NAME_RE } from './mcp-types';
import { validateMcpArguments } from './mcp-schema';

const logger = createLogger('Mcp');

/** Supported MCP protocol versions, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_SERVER_NAME = 'qodalis-cli-server';
export const MCP_SERVER_VERSION: string = PACKAGE_VERSION;

/** MCP endpoint options (`mcp` option of `createCliServer`). */
export interface CliMcpOptions {
    /** Default true when the object is given. */
    enabled?: boolean;
    /** Allow-list of tool names; a trailing `*` matches a prefix (`weather_*`). */
    tools?: string[];
    /** Deny-list (same syntax), applied after `tools`. */
    exclude?: string[];
    /** Only without an auth provider: required static bearer token. */
    token?: string;
    /** Returned by `initialize`. */
    instructions?: string;
}

/** Resolves the `mcp` server option: undefined when MCP is disabled. */
export function resolveMcpOptions(option: boolean | CliMcpOptions | undefined): CliMcpOptions | undefined {
    if (!option) return undefined;
    if (option === true) return {};
    return option.enabled === false ? undefined : option;
}

/** True when `name` matches a pattern (exact, or prefix with a trailing `*`); case-insensitive. */
export function mcpToolPatternMatches(name: string, pattern: string): boolean {
    const p = pattern.trim().toLowerCase();
    const n = name.toLowerCase();
    return p.endsWith('*') ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** Applies the allow-list (`tools`) then the deny-list (`exclude`). */
export function isMcpToolAllowed(name: string, tools?: readonly string[], exclude?: readonly string[]): boolean {
    if (tools && !tools.some((p) => mcpToolPatternMatches(name, p))) return false;
    if (exclude && exclude.some((p) => mcpToolPatternMatches(name, p))) return false;
    return true;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string, ...args: unknown[]): void {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message, ...args);
}

/**
 * Collects the tools of every provider, in priority order (first wins on a
 * name collision, with a warning). Invalid tool names are skipped.
 */
export async function collectMcpTools(providers: readonly McpToolProvider[]): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const owners = new Map<string, string>();
    for (const provider of providers) {
        let provided: McpTool[];
        try {
            provided = await provider.getTools();
        } catch (err) {
            logger.error("MCP tool provider '%s' failed: %s", provider.name, (err as Error)?.message ?? err);
            continue;
        }
        for (const tool of provided ?? []) {
            if (!tool || typeof tool.name !== 'string' || !MCP_TOOL_NAME_RE.test(tool.name)) {
                warnOnce(`invalid|${provider.name}|${tool?.name}`, "MCP tool '%s' of provider '%s' has an invalid name and is skipped", tool?.name, provider.name);
                continue;
            }
            const owner = owners.get(tool.name);
            if (owner !== undefined) {
                warnOnce(`dup|${tool.name}|${provider.name}`, "MCP tool name collision: '%s' from provider '%s' is skipped ('%s' wins)", tool.name, provider.name, owner);
                continue;
            }
            owners.set(tool.name, provider.name);
            tools.push(tool);
        }
    }
    return tools;
}

export interface McpControllerOptions {
    /** Tool providers in priority order (read on every request). */
    providers: () => readonly McpToolProvider[];
    mcp: CliMcpOptions;
    /** The current auth provider (may be installed after creation). */
    getAuth: () => ICliServerAuth | undefined;
    allowedOrigins?: string[];
    trustProxy?: boolean | number;
}

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

class JsonRpcError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}

type JsonRpcId = string | number | null;

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison of a presented bearer token with the configured one. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
    if (presented === undefined) return false;
    return timingSafeEqual(sha256(presented), sha256(expected));
}

function bearerToken(req: Request): string | undefined {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
    const token = header.slice(7).trim();
    return token || undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks done before the server auth gate: the `Origin` (DNS-rebinding
 * protection: allowed or same-origin, else 403) and the method (`POST` only,
 * else 405 with `Allow: POST`).
 */
export function createMcpPreGate(options: Pick<McpControllerOptions, 'allowedOrigins' | 'trustProxy'>): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.path !== '/' && req.path !== '') {
            next();
            return;
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !isOriginAllowed(origin, options.allowedOrigins) && !isSameOrigin(origin, req, options.trustProxy)) {
            res.status(403).json({ error: 'forbidden: origin not allowed' });
            return;
        }
        const method = req.method.toUpperCase();
        if (method === 'OPTIONS' || method === 'POST') {
            next();
            return;
        }
        res.setHeader('Allow', 'POST');
        res.status(405).json({ error: 'method not allowed' });
    };
}

/**
 * MCP "Streamable HTTP" endpoint, stateless and JSON-only: `POST` a JSON-RPC
 * 2.0 message, get a JSON response (`202` for notifications). Tools are the
 * registry's commands, built on every request and filtered by the caller's
 * permissions; calls run through the same executor as `/execute`.
 */
export function createMcpController(options: McpControllerOptions): Router {
    const { mcp, getAuth } = options;
    const router = Router();

    router.post('/', express.text({ type: () => true, limit: '1mb' }), async (req: Request, res: Response) => {
        const auth = getAuth();
        const protectedServer = !!auth?.protectServer;
        let ctx: CliServerAuthContext | undefined;
        if (protectedServer) {
            // Authenticated (and `commands:execute` checked) by the server auth gate
            ctx = req.qcliServerAuth;
            if (!ctx) {
                res.status(401).json({ error: 'unauthorized' });
                return;
            }
        } else if (mcp.token && !tokenMatches(bearerToken(req), mcp.token)) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        const raw = typeof req.body === 'string' ? req.body : '';
        let message: unknown;
        try {
            message = JSON.parse(raw);
        } catch {
            sendRpc(res, null, undefined, new JsonRpcError(PARSE_ERROR, 'Parse error'));
            return;
        }

        if (!isPlainObject(message)) {
            sendRpc(res, null, undefined, new JsonRpcError(INVALID_REQUEST, 'Invalid Request'));
            return;
        }
        const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
        const rawId = message.id;
        const validId = typeof rawId === 'string' || (typeof rawId === 'number' && Number.isFinite(rawId));
        const id: JsonRpcId = validId ? (rawId as string | number) : null;

        if (message.jsonrpc !== '2.0') {
            sendRpc(res, id, undefined, new JsonRpcError(INVALID_REQUEST, 'Invalid Request'));
            return;
        }
        if (message.method === undefined && hasId && ('result' in message || 'error' in message)) {
            // A JSON-RPC response from the client: nothing to answer
            res.status(202).end();
            return;
        }
        if (typeof message.method !== 'string' || (hasId && !validId)) {
            sendRpc(res, id, undefined, new JsonRpcError(INVALID_REQUEST, 'Invalid Request'));
            return;
        }
        if (!hasId) {
            // Notification (e.g. notifications/initialized): accepted, no body
            res.status(202).end();
            return;
        }
        const params = message.params;
        if (params !== undefined && !isPlainObject(params)) {
            sendRpc(res, id, undefined, new JsonRpcError(INVALID_PARAMS, 'Invalid params: params must be an object'));
            return;
        }

        const abortController = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) abortController.abort();
        });

        try {
            const result = await dispatch(message.method, (params ?? {}) as Record<string, unknown>, ctx, abortController.signal, req);
            sendRpc(res, id, result);
        } catch (err) {
            if (err instanceof JsonRpcError) {
                sendRpc(res, id, undefined, err);
            } else {
                logger.error('MCP request failed: %s', (err as Error)?.message ?? err);
                sendRpc(res, id, undefined, new JsonRpcError(INTERNAL_ERROR, 'Internal error'));
            }
        }
    });

    // Body too large / unreadable: plain HTTP errors
    router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
        if (err && (err.type === 'entity.too.large' || typeof err.status === 'number')) {
            const status = err.type === 'entity.too.large' ? 413 : err.status;
            res.status(status).json({ error: status === 413 ? 'request body too large' : 'bad request' });
            return;
        }
        next(err);
    });

    /** Tools visible to the caller: allow/deny lists, then the tool's permissions (when protected). */
    const visibleTools = async (ctx: CliServerAuthContext | undefined): Promise<McpTool[]> => {
        const auth = getAuth();
        const tools = await collectMcpTools(options.providers());
        return tools.filter((tool) => {
            if (!isMcpToolAllowed(tool.name, mcp.tools, mcp.exclude)) return false;
            if (!auth?.protectServer) return true;
            if (!ctx) return false;
            return (tool.requiredPermissions ?? []).every((p) => auth.hasPermission(ctx, p));
        });
    };

    const dispatch = async (
        method: string,
        params: Record<string, unknown>,
        ctx: CliServerAuthContext | undefined,
        signal: AbortSignal,
        req: Request,
    ): Promise<unknown> => {
        switch (method) {
            case 'initialize': {
                const requested = params.protocolVersion;
                if (typeof requested !== 'string') {
                    throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: protocolVersion is required');
                }
                const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
                    ? requested
                    : MCP_PROTOCOL_VERSIONS[0];
                return {
                    protocolVersion,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
                    ...(mcp.instructions ? { instructions: mcp.instructions } : {}),
                };
            }
            case 'ping':
                return {};
            case 'tools/list':
                return {
                    tools: (await visibleTools(ctx)).map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        ...(t.annotations ? { annotations: t.annotations } : {}),
                    })),
                };
            case 'tools/call':
                return callTool(params, ctx, signal, req);
            default:
                throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
    };

    const callTool = async (
        params: Record<string, unknown>,
        ctx: CliServerAuthContext | undefined,
        signal: AbortSignal,
        req: Request,
    ): Promise<unknown> => {
        const name = params.name;
        if (typeof name !== 'string' || !name) {
            throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: name is required');
        }
        const args = params.arguments ?? {};
        if (!isPlainObject(args)) {
            throw new JsonRpcError(INVALID_PARAMS, 'Invalid params: arguments must be an object');
        }
        const tool = (await visibleTools(ctx)).find((t) => t.name === name);
        if (!tool) {
            throw new JsonRpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        const invalid = validateMcpArguments(tool.inputSchema, args);
        if (invalid) {
            throw new JsonRpcError(INVALID_PARAMS, `Invalid arguments for tool ${name}: ${invalid}`);
        }
        logger.debug('MCP tool call: %s (user=%s)', tool.name, ctx?.userName ?? '-');
        let result: McpToolResult;
        try {
            result = await tool.call(args, { auth: ctx, signal, request: req });
        } catch (err) {
            result = { text: `Error executing tool: ${(err as Error)?.message ?? err}`, isError: true };
        }
        return {
            content: [{ type: 'text', text: result?.text ?? '' }],
            isError: !!result?.isError,
            ...(result?.structured && typeof result.structured === 'object' && !Array.isArray(result.structured)
                ? { structuredContent: result.structured }
                : {}),
        };
    };

    return router;
}

function sendRpc(res: Response, id: JsonRpcId, result?: unknown, error?: JsonRpcError): void {
    res.status(200).type('application/json');
    if (error) {
        res.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message } }));
    } else {
        res.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }
}
