import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerSchemaColumn,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import { Client } from '@elastic/elasticsearch';

export interface ElasticsearchConnectionOptions {
    node: string;
}

interface CatIndexRecord {
    index?: string;
    [key: string]: unknown;
}

interface MappingProperty {
    type?: string;
    properties?: Record<string, MappingProperty>;
    fields?: Record<string, MappingProperty>;
}

function flattenMappingProperties(
    properties: Record<string, MappingProperty>,
    prefix = '',
): DataExplorerSchemaColumn[] {
    const columns: DataExplorerSchemaColumn[] = [];
    for (const [key, value] of Object.entries(properties)) {
        const fieldName = prefix ? `${prefix}.${key}` : key;
        if (value.properties) {
            columns.push(...flattenMappingProperties(value.properties, fieldName));
        } else {
            columns.push({
                name: fieldName,
                type: value.type ?? 'object',
                nullable: true,
                primaryKey: false,
            });
        }
    }
    return columns;
}

export class ElasticsearchDataExplorerProvider implements IDataExplorerProvider {
    private readonly client: Client;

    constructor(connectionOptions: ElasticsearchConnectionOptions) {
        this.client = new Client({ node: connectionOptions.node });
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        try {
            const result = await this.executeQuery(context);
            return {
                ...result,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
            } as DataExplorerResult;
        } catch (error) {
            return {
                success: false,
                source: context.options.name,
                language: context.options.language,
                defaultOutputFormat: context.options.defaultOutputFormat,
                executionTime: Date.now() - startTime,
                columns: null,
                rows: [],
                rowCount: 0,
                truncated: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const catResponse = await this.client.transport.request({
            method: 'GET',
            path: '/_cat/indices',
            querystring: { format: 'json' },
        });

        const indices = catResponse as CatIndexRecord[];
        const tables: DataExplorerSchemaTable[] = [];

        for (const indexRecord of indices) {
            const indexName = indexRecord['index'] ?? String(indexRecord);
            if (!indexName || indexName.startsWith('.')) {
                continue;
            }

            try {
                const mappingResponse = await this.client.transport.request({
                    method: 'GET',
                    path: `/${indexName}/_mapping`,
                });

                const mappingData = mappingResponse as Record<string, {
                    mappings?: {
                        properties?: Record<string, MappingProperty>;
                    };
                }>;

                const indexMapping = mappingData[indexName];
                const properties = indexMapping?.mappings?.properties ?? {};
                const fieldColumns = flattenMappingProperties(properties);

                const columns: DataExplorerSchemaColumn[] = [
                    { name: '_id', type: 'keyword', nullable: false, primaryKey: true },
                    ...fieldColumns,
                ];

                tables.push({
                    name: indexName,
                    type: 'index',
                    columns,
                });
            } catch {
                tables.push({
                    name: indexName,
                    type: 'index',
                    columns: [
                        { name: '_id', type: 'keyword', nullable: false, primaryKey: true },
                    ],
                });
            }
        }

        return { source: options.name, tables };
    }

    private async executeQuery(
        context: DataExplorerExecutionContext,
    ): Promise<Partial<DataExplorerResult>> {
        const query = context.query.trim();
        const lines = query.split('\n');
        const firstLine = lines[0].trim();
        const bodyLines = lines.slice(1).join('\n').trim();
        const body = bodyLines ? JSON.parse(bodyLines) : undefined;

        let method: string;
        let path: string;

        // Convenience shortcut: bare path without verb (starts with _ or /)
        if (firstLine.startsWith('_') || firstLine.startsWith('/')) {
            method = 'GET';
            path = firstLine.startsWith('/') ? firstLine : `/${firstLine}`;
        } else {
            const spaceIdx = firstLine.indexOf(' ');
            if (spaceIdx === -1) {
                throw new Error(
                    `Invalid query format. Expected "VERB /path" or a bare path starting with "_" or "/". Got: ${firstLine}`,
                );
            }
            method = firstLine.substring(0, spaceIdx).toUpperCase();
            path = firstLine.substring(spaceIdx + 1).trim();
            if (!path.startsWith('/')) {
                path = `/${path}`;
            }

            const allowedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'];
            if (!allowedMethods.includes(method)) {
                throw new Error(
                    `Unsupported HTTP method: ${method}. Allowed: ${allowedMethods.join(', ')}`,
                );
            }
        }

        // For _cat endpoints, force JSON format
        const isCat = path.includes('/_cat/') || path === '/_cat';
        const querystring: Record<string, string> = isCat ? { format: 'json' } : {};

        const response = await this.client.transport.request({
            method,
            path,
            body,
            querystring,
        });

        return this.mapResponse(path, response);
    }

    private mapResponse(path: string, response: unknown): Partial<DataExplorerResult> {
        // _search responses: flatten hits.hits[], extract _source fields + _id
        if (path.includes('/_search')) {
            const data = response as {
                hits?: {
                    hits?: Array<{
                        _id?: string;
                        _source?: Record<string, unknown>;
                    }>;
                };
            };
            const hits = data?.hits?.hits ?? [];
            if (hits.length === 0) {
                return {
                    success: true,
                    columns: ['_id'],
                    rows: [],
                    rowCount: 0,
                    truncated: false,
                    error: null,
                };
            }

            // Collect all unique columns from _source fields across all hits
            const columnSet = new Set<string>();
            for (const hit of hits) {
                for (const key of Object.keys(hit._source ?? {})) {
                    columnSet.add(key);
                }
            }
            const columns = ['_id', ...Array.from(columnSet)];

            const rows = hits.map((hit) => {
                const source = hit._source ?? {};
                return columns.map((col) =>
                    col === '_id' ? hit._id : source[col],
                );
            });

            return {
                success: true,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                error: null,
            };
        }

        // _cat responses: already forced to JSON, should be an array of objects
        if (path.includes('/_cat/') || path === '/_cat') {
            const records = response as Record<string, unknown>[];
            if (!Array.isArray(records) || records.length === 0) {
                return {
                    success: true,
                    columns: [],
                    rows: [],
                    rowCount: 0,
                    truncated: false,
                    error: null,
                };
            }

            const columns = Object.keys(records[0]);
            const rows = records.map((record) => columns.map((col) => record[col]));

            return {
                success: true,
                columns,
                rows,
                rowCount: rows.length,
                truncated: false,
                error: null,
            };
        }

        // Generic response: return raw JSON as a single-row result
        const responseJson = JSON.stringify(response, null, 2);
        return {
            success: true,
            columns: ['response'],
            rows: [[responseJson]],
            rowCount: 1,
            truncated: false,
            error: null,
        };
    }
}
