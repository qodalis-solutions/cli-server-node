import {
    IDataExplorerProvider,
    DataExplorerExecutionContext,
    DataExplorerResult,
    DataExplorerSchemaResult,
    DataExplorerSchemaTable,
    DataExplorerSchemaColumn,
    DataExplorerProviderOptions,
} from '@qodalis/cli-server-abstractions';
import { MongoClient } from 'mongodb';

export interface MongoConnectionOptions {
    connectionString: string;
    database: string;
}

export class MongoDataExplorerProvider implements IDataExplorerProvider {
    private readonly connectionOptions: MongoConnectionOptions;

    constructor(connectionOptions: MongoConnectionOptions) {
        this.connectionOptions = connectionOptions;
    }

    async getSchemaAsync(options: DataExplorerProviderOptions): Promise<DataExplorerSchemaResult> {
        const client = new MongoClient(this.connectionOptions.connectionString);
        try {
            await client.connect();
            const db = client.db(this.connectionOptions.database);
            const collections = await db.listCollections().toArray();

            const tables: DataExplorerSchemaTable[] = [];
            for (const coll of collections) {
                const sample = await db.collection(coll.name).findOne();
                const columns: DataExplorerSchemaColumn[] = sample
                    ? Object.entries(sample).map(([key, value]) => ({
                          name: key,
                          type: Array.isArray(value) ? 'array' : typeof value === 'object' && value !== null ? 'object' : typeof value,
                          nullable: true,
                          primaryKey: key === '_id',
                      }))
                    : [];
                tables.push({
                    name: coll.name,
                    type: coll.type ?? 'collection',
                    columns,
                });
            }

            return { source: options.name, tables };
        } finally {
            await client.close();
        }
    }

    async executeAsync(context: DataExplorerExecutionContext): Promise<DataExplorerResult> {
        const startTime = Date.now();
        const client = new MongoClient(this.connectionOptions.connectionString);
        try {
            await client.connect();
            const db = client.db(this.connectionOptions.database);
            const query = context.query.trim();

            // Handle convenience commands
            if (query.toLowerCase() === 'show collections') {
                const collections = await db.listCollections().toArray();
                const rows = collections.map((c) => ({ name: c.name, type: c.type }));
                return this.successResult(context, startTime, null, rows, rows.length);
            }

            if (
                query.toLowerCase() === 'show dbs' ||
                query.toLowerCase() === 'show databases'
            ) {
                const admin = client.db('admin');
                const result = await admin.command({ listDatabases: 1 });
                const rows = result.databases.map((d: any) => ({
                    name: d.name,
                    sizeOnDisk: d.sizeOnDisk,
                    empty: d.empty,
                }));
                return this.successResult(context, startTime, null, rows, rows.length);
            }

            // Parse db.collection.operation(...) syntax
            const parsed = this.parseQuery(query);
            if (!parsed) {
                return this.errorResult(
                    context,
                    startTime,
                    'Invalid query syntax. Use: db.collection.find({...}), db.collection.aggregate([...]), show collections, show dbs',
                );
            }

            const collection = db.collection(parsed.collection);

            switch (parsed.operation) {
                case 'find': {
                    const filter = parsed.args[0] || {};
                    const projection = parsed.args[1] || {};
                    const cursor = collection.find(filter, { projection });
                    const maxRows = context.options.maxRows ?? 1000;
                    const docs = await cursor.limit(maxRows + 1).toArray();
                    const truncated = docs.length > maxRows;
                    if (truncated) docs.pop();
                    return this.successResult(context, startTime, null, docs, docs.length, truncated);
                }
                case 'findOne': {
                    const filter = parsed.args[0] || {};
                    const doc = await collection.findOne(filter);
                    const rows = doc ? [doc] : [];
                    return this.successResult(context, startTime, null, rows, rows.length);
                }
                case 'aggregate': {
                    const pipeline = parsed.args[0] || [];
                    const docs = await collection.aggregate(pipeline).toArray();
                    return this.successResult(context, startTime, null, docs, docs.length);
                }
                case 'insertOne': {
                    const result = await collection.insertOne(parsed.args[0] || {});
                    return this.successResult(context, startTime, null, [
                        { acknowledged: result.acknowledged, insertedId: String(result.insertedId) },
                    ], 1);
                }
                case 'insertMany': {
                    const result = await collection.insertMany(parsed.args[0] || []);
                    return this.successResult(context, startTime, null, [
                        { acknowledged: result.acknowledged, insertedCount: result.insertedCount },
                    ], 1);
                }
                case 'updateOne': {
                    const result = await collection.updateOne(
                        parsed.args[0] || {},
                        parsed.args[1] || {},
                    );
                    return this.successResult(context, startTime, null, [
                        {
                            acknowledged: result.acknowledged,
                            matchedCount: result.matchedCount,
                            modifiedCount: result.modifiedCount,
                        },
                    ], 1);
                }
                case 'updateMany': {
                    const result = await collection.updateMany(
                        parsed.args[0] || {},
                        parsed.args[1] || {},
                    );
                    return this.successResult(context, startTime, null, [
                        {
                            acknowledged: result.acknowledged,
                            matchedCount: result.matchedCount,
                            modifiedCount: result.modifiedCount,
                        },
                    ], 1);
                }
                case 'deleteOne': {
                    const result = await collection.deleteOne(parsed.args[0] || {});
                    return this.successResult(context, startTime, null, [
                        { acknowledged: result.acknowledged, deletedCount: result.deletedCount },
                    ], 1);
                }
                case 'deleteMany': {
                    const result = await collection.deleteMany(parsed.args[0] || {});
                    return this.successResult(context, startTime, null, [
                        { acknowledged: result.acknowledged, deletedCount: result.deletedCount },
                    ], 1);
                }
                case 'countDocuments': {
                    const count = await collection.countDocuments(parsed.args[0] || {});
                    return this.successResult(context, startTime, ['count'], [[count]], 1);
                }
                case 'distinct': {
                    const values = await collection.distinct(parsed.args[0], parsed.args[1] || {});
                    return this.successResult(
                        context,
                        startTime,
                        null,
                        values.map((v: unknown) => ({ value: v })),
                        values.length,
                    );
                }
                default:
                    return this.errorResult(
                        context,
                        startTime,
                        `Unsupported operation: ${parsed.operation}. Supported: find, findOne, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, countDocuments, distinct`,
                    );
            }
        } catch (error) {
            return this.errorResult(
                context,
                startTime,
                error instanceof Error ? error.message : String(error),
            );
        } finally {
            await client.close();
        }
    }

    private parseQuery(
        query: string,
    ): { collection: string; operation: string; args: any[] } | null {
        // Match db.collectionName.operation(...)
        const match = query.match(/^db\.(\w+)\.(\w+)\(([\s\S]*)\)$/);
        if (!match) return null;

        const collection = match[1];
        const operation = match[2];
        const argsStr = match[3].trim();

        if (!argsStr) {
            return { collection, operation, args: [] };
        }

        try {
            // Parse the arguments - wrap in array for JSON parsing
            const parsed = Function(`"use strict"; return [${argsStr}]`)();
            return { collection, operation, args: parsed };
        } catch {
            return null;
        }
    }

    private successResult(
        context: DataExplorerExecutionContext,
        startTime: number,
        columns: string[] | null,
        rows: unknown[],
        rowCount: number,
        truncated = false,
    ): DataExplorerResult {
        return {
            success: true,
            source: context.options.name,
            language: context.options.language,
            defaultOutputFormat: context.options.defaultOutputFormat,
            executionTime: Date.now() - startTime,
            columns,
            rows: rows as any,
            rowCount,
            truncated,
            error: null,
        };
    }

    private errorResult(
        context: DataExplorerExecutionContext,
        startTime: number,
        error: string,
    ): DataExplorerResult {
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
            error,
        };
    }
}
