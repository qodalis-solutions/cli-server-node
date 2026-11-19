import { readFileSync } from 'fs';
import { resolve } from 'path';

/** An OpenAPI document (JSON object). */
export type OpenApiDocument = Record<string, unknown>;

/** The bearer scheme added as `components.securitySchemes.qcliToken`. */
export const QCLI_TOKEN_SCHEME = {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'qcli_pat',
    description: 'API token (qcli_pat_…), sent as Authorization: Bearer <token>',
} as const;

/** Served when the host set no document: no paths, the additions only. */
const EMPTY_DOCUMENT: OpenApiDocument = { openapi: '3.1.0', info: { title: 'API', version: '1.0.0' }, paths: {} };

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host's document: an object (used as given, read on every request), or a path to a
 * JSON file (relative to the working directory), read once. Throws
 * `public-api: cannot read OpenAPI document <path>` when the file cannot be read or parsed.
 */
export function loadOpenApiSource(source: object | string | undefined): () => OpenApiDocument {
    if (source === undefined) return () => EMPTY_DOCUMENT;
    if (typeof source === 'string') {
        let doc: unknown;
        try {
            doc = JSON.parse(readFileSync(resolve(source), 'utf8'));
        } catch {
            doc = undefined;
        }
        if (!isObject(doc)) {
            throw new Error(`public-api: cannot read OpenAPI document ${source}`);
        }
        return () => doc as OpenApiDocument;
    }
    if (!isObject(source)) {
        throw new Error('public-api: the OpenAPI document must be an object or a path to a JSON file');
    }
    return () => source;
}

/**
 * A copy of the document with what it lacks added (the host's values always win): the
 * `qcliToken` bearer scheme, a top-level `security` requirement for it, and `servers`
 * with `serverUrl`. The source is never modified.
 */
export function publicDocument(source: OpenApiDocument, serverUrl: string): OpenApiDocument {
    const doc = structuredClone(source);
    const components = isObject(doc.components) ? doc.components : (doc.components = {});
    const schemes = isObject(components.securitySchemes) ? components.securitySchemes : (components.securitySchemes = {});
    if (!('qcliToken' in schemes)) {
        schemes.qcliToken = { ...QCLI_TOKEN_SCHEME };
    }
    if (!('security' in doc)) {
        doc.security = [{ qcliToken: [] }];
    }
    if (!Array.isArray(doc.servers) || doc.servers.length === 0) {
        doc.servers = [{ url: serverUrl }];
    }
    return doc;
}

/** The document's `info.title`, or `API`. */
export function documentTitle(doc: OpenApiDocument): string {
    const info = doc.info;
    return isObject(info) && typeof info.title === 'string' && info.title ? info.title : 'API';
}
