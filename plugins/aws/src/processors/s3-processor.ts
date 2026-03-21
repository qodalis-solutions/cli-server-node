import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
    CliStructuredResponse,
} from '@qodalis/cli-server-abstractions';
import {
    S3Client,
    ListBucketsCommand,
    CreateBucketCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
    GetObjectCommand,
    paginateListObjectsV2,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import {
    buildResponse,
    buildErrorResponse,
    buildSuccessResponse,
    formatAsList,
    applyOutputFormat,
    isDryRun,
    formatAsTable,
} from '../utils/output-helpers';
import { paginateAll } from '../utils/pagination';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
    const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
    if (!match) return null;
    return { bucket: match[1], key: match[2] };
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// s3 ls
// ---------------------------------------------------------------------------

class S3LsProcessor extends CliCommandProcessor {
    command = 'ls';
    description = 'List S3 buckets or objects in a bucket';
    valueRequired = false;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
        new CliCommandParameterDescriptor('output', 'Output format (table|json|text)', false, 'string', ['-o'], 'table'),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        const value = command.value?.trim();

        if (!value) {
            // List all buckets
            try {
                const response = await client.send(new ListBucketsCommand({}));
                const buckets = response.Buckets ?? [];

                if (buckets.length === 0) {
                    return buildResponse([{ type: 'text', value: 'No buckets found.', style: 'warning' }]);
                }

                const items = buckets.map((b) => {
                    const date = b.CreationDate ? b.CreationDate.toISOString().slice(0, 10) : '(unknown)';
                    return `${date}  ${b.Name}`;
                });

                const defaultOutput = formatAsList(items);
                return buildResponse([applyOutputFormat(command, defaultOutput, buckets)]);
            } catch (err: any) {
                return buildErrorResponse(`Failed to list buckets: ${err.message ?? err}`);
            }
        }

        // List objects in a bucket
        const parsed = parseS3Uri(value);
        if (!parsed) {
            return buildErrorResponse(`Invalid S3 URI: "${value}". Expected format: s3://bucket[/prefix]`);
        }

        try {
            const paginator = paginateListObjectsV2(
                { client },
                { Bucket: parsed.bucket, Prefix: parsed.key || undefined },
            );

            const objects = await paginateAll(
                paginator,
                (page) => page.Contents ?? [],
            );

            if (objects.length === 0) {
                return buildResponse([{ type: 'text', value: `No objects found in s3://${parsed.bucket}/${parsed.key || ''}`, style: 'warning' }]);
            }

            const rows = objects.map((obj: any) => {
                const date = obj.LastModified ? obj.LastModified.toISOString().slice(0, 19).replace('T', ' ') : '(unknown)';
                const size = obj.Size !== undefined ? formatBytes(obj.Size) : '0 B';
                return [date, size, obj.Key ?? ''];
            });

            const tableOutput = formatAsTable(['Last Modified', 'Size', 'Key'], rows);
            return buildResponse([applyOutputFormat(command, tableOutput, objects)]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to list objects: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 cp
// ---------------------------------------------------------------------------

class S3CpProcessor extends CliCommandProcessor {
    command = 'cp';
    description = 'Copy objects between S3 locations (S3-to-S3 only)';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dest', 'Destination S3 URI (s3://bucket/key)', true, 'string', ['-d']),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const source = command.value?.trim();
        const dest = command.args?.dest as string | undefined;

        if (!source) {
            return buildErrorResponse('Source S3 URI is required. Usage: s3 cp <s3://bucket/key> --dest <s3://bucket/key>');
        }

        if (!dest) {
            return buildErrorResponse('Destination is required. Use --dest <s3://bucket/key>.');
        }

        const srcParsed = parseS3Uri(source);
        if (!srcParsed || !srcParsed.key) {
            return buildErrorResponse(`Invalid source S3 URI: "${source}". Expected format: s3://bucket/key`);
        }

        const dstParsed = parseS3Uri(dest);
        if (!dstParsed || !dstParsed.key) {
            return buildErrorResponse(`Invalid destination S3 URI: "${dest}". Expected format: s3://bucket/key`);
        }

        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(
                new CopyObjectCommand({
                    Bucket: dstParsed.bucket,
                    Key: dstParsed.key,
                    CopySource: `${srcParsed.bucket}/${srcParsed.key}`,
                }),
            );

            return buildSuccessResponse(`Copied ${source} to ${dest}`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to copy object: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 rm
// ---------------------------------------------------------------------------

class S3RmProcessor extends CliCommandProcessor {
    command = 'rm';
    description = 'Delete an S3 object';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dry-run', 'Preview without deleting', false, 'boolean'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const value = command.value?.trim();
        if (!value) {
            return buildErrorResponse('S3 URI is required. Usage: s3 rm <s3://bucket/key>');
        }

        const parsed = parseS3Uri(value);
        if (!parsed || !parsed.key) {
            return buildErrorResponse(`Invalid S3 URI: "${value}". Expected format: s3://bucket/key`);
        }

        if (isDryRun(command)) {
            return buildResponse([
                { type: 'text', value: `[DRY RUN] Would delete ${value}`, style: 'warning' },
            ]);
        }

        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(
                new DeleteObjectCommand({
                    Bucket: parsed.bucket,
                    Key: parsed.key,
                }),
            );

            return buildSuccessResponse(`Deleted ${value}`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to delete object: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 mb (make bucket)
// ---------------------------------------------------------------------------

class S3MbProcessor extends CliCommandProcessor {
    command = 'mb';
    description = 'Create an S3 bucket';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const bucketName = command.value?.trim();
        if (!bucketName) {
            return buildErrorResponse('Bucket name is required. Usage: s3 mb <bucket-name>');
        }

        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new CreateBucketCommand({ Bucket: bucketName }));
            return buildSuccessResponse(`Bucket "${bucketName}" created successfully.`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to create bucket: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 rb (remove bucket)
// ---------------------------------------------------------------------------

class S3RbProcessor extends CliCommandProcessor {
    command = 'rb';
    description = 'Delete an S3 bucket';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('dry-run', 'Preview without deleting', false, 'boolean'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const bucketName = command.value?.trim();
        if (!bucketName) {
            return buildErrorResponse('Bucket name is required. Usage: s3 rb <bucket-name>');
        }

        if (isDryRun(command)) {
            return buildResponse([
                { type: 'text', value: `[DRY RUN] Would delete bucket "${bucketName}"`, style: 'warning' },
            ]);
        }

        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
            return buildSuccessResponse(`Bucket "${bucketName}" deleted successfully.`);
        } catch (err: any) {
            return buildErrorResponse(`Failed to delete bucket: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 presign
// ---------------------------------------------------------------------------

class S3PresignProcessor extends CliCommandProcessor {
    command = 'presign';
    description = 'Generate a pre-signed URL for an S3 object';
    valueRequired = true;
    parameters = [
        new CliCommandParameterDescriptor('expires', 'URL expiration in seconds (default: 3600)', false, 'number', ['-e'], '3600'),
        new CliCommandParameterDescriptor('region', 'AWS region override', false, 'string', ['-r']),
    ];

    constructor(private readonly credentialManager: AwsCredentialManager) {
        super();
    }

    async handleAsync(): Promise<string> {
        return '';
    }

    async handleStructuredAsync(command: CliProcessCommand): Promise<CliStructuredResponse> {
        const value = command.value?.trim();
        if (!value) {
            return buildErrorResponse('S3 URI is required. Usage: s3 presign <s3://bucket/key>');
        }

        const parsed = parseS3Uri(value);
        if (!parsed || !parsed.key) {
            return buildErrorResponse(`Invalid S3 URI: "${value}". Expected format: s3://bucket/key`);
        }

        const expiresIn = command.args?.expires ? Number(command.args.expires) : 3600;
        if (isNaN(expiresIn) || expiresIn <= 0) {
            return buildErrorResponse('--expires must be a positive number of seconds.');
        }

        const client = this.credentialManager.getClient(S3Client, {
            region: command.args?.region ? String(command.args.region) : undefined,
        });

        try {
            const url = await getSignedUrl(
                client,
                new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
                { expiresIn },
            );

            return buildResponse([
                { type: 'text', value: url },
                { type: 'text', value: `Expires in ${expiresIn} seconds.`, style: 'muted' },
            ]);
        } catch (err: any) {
            return buildErrorResponse(`Failed to generate pre-signed URL: ${err.message ?? err}`);
        }
    }
}

// ---------------------------------------------------------------------------
// s3 (parent)
// ---------------------------------------------------------------------------

export class AwsS3Processor extends CliCommandProcessor {
    command = 's3';
    description = 'Amazon S3 operations — list, copy, remove objects and buckets';
    processors: ICliCommandProcessor[];

    constructor(credentialManager: AwsCredentialManager) {
        super();
        this.processors = [
            new S3LsProcessor(credentialManager),
            new S3CpProcessor(credentialManager),
            new S3RmProcessor(credentialManager),
            new S3MbProcessor(credentialManager),
            new S3RbProcessor(credentialManager),
            new S3PresignProcessor(credentialManager),
        ];
    }

    async handleAsync(): Promise<string> {
        return '';
    }
}
