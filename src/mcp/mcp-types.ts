import type { Request } from 'express';
import type { CliServerAuthContext } from '../auth/cli-server-auth';

/** JSON Schema of a property in a tool's input schema (the subset validated by the server). */
export interface McpPropertySchema {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    items?: { type: 'string' | 'number' | 'integer' | 'boolean' };
    description?: string;
    default?: unknown;
    [keyword: string]: unknown;
}

/** JSON Schema of a tool's arguments: always an object without additional properties. */
export interface McpInputSchema {
    type: 'object';
    properties: Record<string, McpPropertySchema>;
    required: string[];
    additionalProperties: false;
}

/** MCP tool annotations (hints for clients). */
export interface McpToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
}

/** Context of a tool call. */
export interface McpToolCallContext {
    /** The caller (when an auth provider protects the server). */
    auth?: CliServerAuthContext;
    /** Aborted when the client disconnects. */
    signal: AbortSignal;
    /** The HTTP request carrying the call. */
    request: Request;
}

/** Result of a tool call: `text` becomes the text content, `structured` the `structuredContent`. */
export interface McpToolResult {
    text: string;
    structured?: Record<string, unknown>;
    isError: boolean;
}

/** A tool exposed by the MCP endpoint. */
export interface McpTool {
    /** `[a-z0-9_-]`, at most 64 characters. */
    name: string;
    description: string;
    inputSchema: McpInputSchema;
    /** Checked for `tools/list` and `tools/call` when an auth provider protects the server. */
    requiredPermissions: string[];
    annotations?: McpToolAnnotations;
    /** Called with arguments already validated against `inputSchema`. */
    call(args: Record<string, unknown>, context: McpToolCallContext): Promise<McpToolResult>;
}

/**
 * Supplies MCP tools. Providers are asked for their tools on every request, so
 * registrations, enabled features and permissions are always current.
 */
export interface McpToolProvider {
    /** Provider name (used in logs). */
    readonly name: string;
    getTools(): McpTool[] | Promise<McpTool[]>;
}

/** MCP tool name rule: `[a-z0-9_-]`, 1-64 characters. */
export const MCP_TOOL_NAME_RE = /^[a-z0-9_-]{1,64}$/;

/** Builds an input schema from properties and required names. */
export function mcpObjectSchema(properties: Record<string, McpPropertySchema> = {}, required: string[] = []): McpInputSchema {
    return { type: 'object', properties, required, additionalProperties: false };
}

/** Error result with a message. */
export function mcpError(message: string): McpToolResult {
    return { text: message, isError: true };
}

/** Success result with a structured object rendered as pretty JSON text. */
export function mcpJson(value: Record<string, unknown>, text?: string): McpToolResult {
    return { text: text ?? JSON.stringify(value, null, 2), structured: value, isError: false };
}
