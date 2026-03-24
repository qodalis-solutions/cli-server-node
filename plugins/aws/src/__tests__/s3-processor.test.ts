import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
    S3Client,
    ListBucketsCommand,
    CreateBucketCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { AwsS3Processor, parseS3Uri, formatBytes } from '../processors/s3-processor';
import { AwsConfigService } from '../services/aws-config-service';
import { AwsCredentialManager } from '../services/aws-credential-manager';
import { CliProcessCommand } from '@qodalis/cli-server-abstractions';

const s3Mock = mockClient(S3Client);

function makeCommand(overrides: Partial<CliProcessCommand> = {}): CliProcessCommand {
    return {
        command: 'aws s3',
        rawCommand: 'aws s3',
        chainCommands: [],
        args: {},
        ...overrides,
    };
}

describe('parseS3Uri', () => {
    it('should parse a bucket-only URI', () => {
        expect(parseS3Uri('s3://my-bucket')).toEqual({ bucket: 'my-bucket', key: '' });
    });

    it('should parse a bucket with trailing slash', () => {
        expect(parseS3Uri('s3://my-bucket/')).toEqual({ bucket: 'my-bucket', key: '' });
    });

    it('should parse a full URI with key', () => {
        expect(parseS3Uri('s3://my-bucket/path/to/object.txt')).toEqual({
            bucket: 'my-bucket',
            key: 'path/to/object.txt',
        });
    });

    it('should return null for invalid URIs', () => {
        expect(parseS3Uri('not-an-s3-uri')).toBeNull();
        expect(parseS3Uri('http://example.com')).toBeNull();
        expect(parseS3Uri('')).toBeNull();
    });
});

describe('formatBytes', () => {
    it('should format 0 bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
        expect(formatBytes(512)).toBe('512.0 B');
    });

    it('should format kilobytes', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
    });

    it('should format megabytes', () => {
        expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('should format gigabytes', () => {
        expect(formatBytes(1073741824)).toBe('1.0 GB');
    });
});

describe('AwsS3Processor', () => {
    let processor: AwsS3Processor;
    let credentialManager: AwsCredentialManager;

    beforeEach(() => {
        s3Mock.reset();
        const configService = new AwsConfigService();
        configService.setCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        configService.setRegion('us-east-1');
        credentialManager = new AwsCredentialManager(configService);
        processor = new AwsS3Processor(credentialManager);
    });

    function findSub(name: string) {
        const sub = processor.processors!.find((p) => p.command === name);
        if (!sub) throw new Error(`Sub-processor "${name}" not found`);
        return sub;
    }

    // -------------------------------------------------------------------
    // ls
    // -------------------------------------------------------------------
    describe('ls', () => {
        it('should list all buckets when no path given', async () => {
            s3Mock.on(ListBucketsCommand).resolves({
                Buckets: [
                    { Name: 'bucket-a', CreationDate: new Date('2024-01-15') },
                    { Name: 'bucket-b', CreationDate: new Date('2024-06-20') },
                ],
            });

            const sub = findSub('ls');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            expect(result.outputs.length).toBeGreaterThan(0);
            // Should contain bucket names in some form
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('bucket-a');
            expect(text).toContain('bucket-b');
        });

        it('should return warning when no buckets found', async () => {
            s3Mock.on(ListBucketsCommand).resolves({ Buckets: [] });

            const sub = findSub('ls');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('No buckets found');
        });

        it('should return error for invalid S3 URI', async () => {
            const sub = findSub('ls');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'not-an-s3-uri' }));

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Invalid S3 URI');
        });
    });

    // -------------------------------------------------------------------
    // mb
    // -------------------------------------------------------------------
    describe('mb', () => {
        it('should create a bucket', async () => {
            s3Mock.on(CreateBucketCommand).resolves({});

            const sub = findSub('mb');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'my-new-bucket' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('my-new-bucket');
            expect(text).toContain('created');
        });

        it('should require a bucket name', async () => {
            const sub = findSub('mb');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Bucket name is required');
        });
    });

    // -------------------------------------------------------------------
    // rb
    // -------------------------------------------------------------------
    describe('rb', () => {
        it('should delete a bucket', async () => {
            s3Mock.on(DeleteBucketCommand).resolves({});

            const sub = findSub('rb');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'old-bucket' }));

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('old-bucket');
            expect(text).toContain('deleted');
        });

        it('should support dry-run', async () => {
            const sub = findSub('rb');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 'old-bucket', args: { 'dry-run': true } }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('DRY RUN');
            expect(text).toContain('old-bucket');

            // Verify no actual delete was sent
            expect(s3Mock.commandCalls(DeleteBucketCommand).length).toBe(0);
        });
    });

    // -------------------------------------------------------------------
    // rm
    // -------------------------------------------------------------------
    describe('rm', () => {
        it('should delete an object', async () => {
            s3Mock.on(DeleteObjectCommand).resolves({});

            const sub = findSub('rm');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 's3://my-bucket/path/file.txt' }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Deleted');
        });

        it('should support dry-run without deleting', async () => {
            const sub = findSub('rm');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 's3://my-bucket/path/file.txt', args: { 'dry-run': true } }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('DRY RUN');

            expect(s3Mock.commandCalls(DeleteObjectCommand).length).toBe(0);
        });

        it('should return error for invalid URI', async () => {
            const sub = findSub('rm');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'bad-uri' }));

            expect(result.exitCode).toBe(1);
        });
    });

    // -------------------------------------------------------------------
    // cp
    // -------------------------------------------------------------------
    describe('cp', () => {
        it('should copy an object between S3 locations', async () => {
            s3Mock.on(CopyObjectCommand).resolves({});

            const sub = findSub('cp');
            const result = await sub.handleStructuredAsync!(
                makeCommand({
                    value: 's3://src-bucket/file.txt',
                    args: { dest: 's3://dst-bucket/file.txt' },
                }),
            );

            expect(result.exitCode).toBe(0);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('Copied');
        });

        it('should require both source and dest', async () => {
            const sub = findSub('cp');

            const noSource = await sub.handleStructuredAsync!(makeCommand());
            expect(noSource.exitCode).toBe(1);

            const noDest = await sub.handleStructuredAsync!(
                makeCommand({ value: 's3://bucket/key' }),
            );
            expect(noDest.exitCode).toBe(1);
        });
    });

    // -------------------------------------------------------------------
    // presign
    // -------------------------------------------------------------------
    describe('presign', () => {
        it('should return error for missing URI', async () => {
            const sub = findSub('presign');
            const result = await sub.handleStructuredAsync!(makeCommand());

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('S3 URI is required');
        });

        it('should return error for invalid URI', async () => {
            const sub = findSub('presign');
            const result = await sub.handleStructuredAsync!(makeCommand({ value: 'not-s3' }));

            expect(result.exitCode).toBe(1);
        });

        it('should return error for invalid expires value', async () => {
            const sub = findSub('presign');
            const result = await sub.handleStructuredAsync!(
                makeCommand({ value: 's3://bucket/key.txt', args: { expires: 'abc' } }),
            );

            expect(result.exitCode).toBe(1);
            const text = JSON.stringify(result.outputs);
            expect(text).toContain('positive number');
        });
    });
});
