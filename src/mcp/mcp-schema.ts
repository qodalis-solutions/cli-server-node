import { McpInputSchema, McpPropertySchema } from './mcp-types';

function typeMatches(type: string | undefined, value: unknown): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return typeof value === 'number' && Number.isInteger(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'object':
            return value !== null && typeof value === 'object' && !Array.isArray(value);
        case 'array':
            return Array.isArray(value);
        default:
            return true;
    }
}

const TYPE_LABEL: Record<string, string> = {
    string: 'a string',
    number: 'a number',
    integer: 'an integer',
    boolean: 'a boolean',
    object: 'an object',
    array: 'an array',
};

function checkProperty(key: string, prop: McpPropertySchema, value: unknown): string | undefined {
    if (!typeMatches(prop.type, value)) {
        if (prop.type === 'array' && prop.items?.type) return `argument '${key}' must be an array of ${prop.items.type}s`;
        return `argument '${key}' must be ${TYPE_LABEL[prop.type] ?? prop.type}`;
    }
    if (prop.type === 'array' && prop.items?.type && (value as unknown[]).some((v) => !typeMatches(prop.items!.type, v))) {
        return `argument '${key}' must be an array of ${prop.items.type}s`;
    }
    return undefined;
}

/**
 * Validates tool arguments against an input schema (types of the declared
 * properties, array item types, unknown properties, required properties).
 * Returns the reason when invalid. `null` counts as absent.
 */
export function validateMcpArguments(schema: McpInputSchema, args: Record<string, unknown>): string | undefined {
    const properties = schema.properties ?? {};
    for (const [key, value] of Object.entries(args)) {
        const prop = Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : undefined;
        if (!prop) return `unknown argument '${key}'`;
        if (value === null || value === undefined) continue;
        const reason = checkProperty(key, prop, value);
        if (reason) return reason;
    }
    for (const key of schema.required ?? []) {
        if (args[key] === undefined || args[key] === null) return `missing required argument '${key}'`;
    }
    return undefined;
}
