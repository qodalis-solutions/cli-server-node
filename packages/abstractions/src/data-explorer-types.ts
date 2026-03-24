/** Query language supported by a data explorer provider. */
export enum DataExplorerLanguage {
    Sql = 'sql',
    Json = 'json',
    Shell = 'shell',
    Graphql = 'graphql',
    Redis = 'redis',
    Elasticsearch = 'elasticsearch',
}

/** Output format for data explorer query results. */
export enum DataExplorerOutputFormat {
    Table = 'table',
    Json = 'json',
    Csv = 'csv',
    Raw = 'raw',
}

/** Predefined query template for a data explorer provider. */
export interface DataExplorerTemplate {
    /** Template display name. */
    name: string;
    /** Query string, optionally with parameter placeholders. */
    query: string;
    /** Human-readable description of what this template does. */
    description?: string;
    /** Default parameter values for this template. */
    parameters?: Record<string, unknown>;
}

/** Describes a parameter accepted by a data explorer provider. */
export interface DataExplorerParameterDescriptor {
    /** Parameter name. */
    name: string;
    /** Human-readable description. */
    description?: string;
    /** Whether the parameter must be provided. */
    required?: boolean;
    /** Default value when omitted. */
    defaultValue?: unknown;
}

/** Configuration options that define a data explorer provider's identity and capabilities. */
export interface DataExplorerProviderOptions {
    /** Unique provider name (e.g. "postgres", "mongodb"). */
    name: string;
    /** Human-readable description of the data source. */
    description: string;
    /** Query language used by this provider. */
    language: DataExplorerLanguage;
    /** Default output format for query results. */
    defaultOutputFormat: DataExplorerOutputFormat;
    /** Parameters accepted by this provider. */
    parameters?: DataExplorerParameterDescriptor[];
    /** Predefined query templates. */
    templates?: DataExplorerTemplate[];
    /** Query execution timeout in milliseconds. */
    timeout?: number;
    /** Maximum number of rows to return per query. */
    maxRows?: number;
}

/** Context passed to a data explorer provider when executing a query. */
export interface DataExplorerExecutionContext {
    /** Query string to execute. */
    query: string;
    /** Parameter values for the query. */
    parameters: Record<string, unknown>;
    /** Provider configuration options. */
    options: DataExplorerProviderOptions;
    /** Abort signal for cancellation. */
    signal?: AbortSignal;
}

/** Result of a data explorer query execution. */
export interface DataExplorerResult {
    /** Whether the query executed without errors. */
    success: boolean;
    /** Provider source name that produced this result. */
    source: string;
    /** Query language used. */
    language: DataExplorerLanguage;
    /** Output format of the result data. */
    defaultOutputFormat: DataExplorerOutputFormat;
    /** Query execution time in milliseconds. */
    executionTime: number;
    /** Column names, or null if not applicable. */
    columns: string[] | null;
    /** Result rows as arrays or objects. */
    rows: unknown[][] | Record<string, unknown>[];
    /** Total number of rows returned. */
    rowCount: number;
    /** Whether the result was truncated due to maxRows. */
    truncated: boolean;
    /** Error message if the query failed, otherwise null. */
    error: string | null;
}

/** Request payload for executing a data explorer query. */
export interface DataExplorerExecuteRequest {
    /** Target data source name. */
    source: string;
    /** Query string to execute. */
    query: string;
    /** Optional parameter values. */
    parameters?: Record<string, unknown>;
}

/** Metadata about a registered data explorer source. */
export interface DataExplorerSourceInfo {
    /** Source name. */
    name: string;
    /** Human-readable description. */
    description: string;
    /** Query language used by this source. */
    language: DataExplorerLanguage;
    /** Default output format. */
    defaultOutputFormat: DataExplorerOutputFormat;
    /** Available query templates. */
    templates: DataExplorerTemplate[];
    /** Accepted parameters. */
    parameters: DataExplorerParameterDescriptor[];
}

/** Describes a single column within a data explorer schema table. */
export interface DataExplorerSchemaColumn {
    /** Column name. */
    name: string;
    /** Data type (e.g. "varchar", "integer"). */
    type: string;
    /** Whether the column allows null values. */
    nullable: boolean;
    /** Whether the column is a primary key. */
    primaryKey: boolean;
}

/** Describes a table or collection in a data explorer schema. */
export interface DataExplorerSchemaTable {
    /** Table or collection name. */
    name: string;
    /** Object type (e.g. "table", "view", "collection"). */
    type: string;
    /** Columns within this table. */
    columns: DataExplorerSchemaColumn[];
}

/** Schema introspection result from a data explorer provider. */
export interface DataExplorerSchemaResult {
    /** Provider source name. */
    source: string;
    /** Tables and their column definitions. */
    tables: DataExplorerSchemaTable[];
}
