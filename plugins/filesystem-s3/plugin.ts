/**
 * The entry point of the S3 file storage installed at runtime (`qodalis.entry`): the filesystem API over an S3 (or
 * S3-compatible) bucket. The bucket, region, prefix and endpoint are settings, the access keys `secret` settings
 * (never returned; without them the AWS default credential chain is used). Read-only unless `readOnly` is turned off.
 * Nothing is served until a bucket is set (then a restart). Refused when the host already set the filesystem storage.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { readOnlyFileStorage } from '@qodalis/cli-server-plugin-filesystem';
import { S3FileStorageProvider } from './s3-provider';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'filesystem-s3', package: '@qodalis/cli-server-plugin-filesystem-s3', title: 'Filesystem S3', icon: '🪣' };

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'bucket', label: 'Bucket', type: 'string', required: true, default: '', requiresRestart: true, validation: { max: 63 } },
    { key: 'region', label: 'Region', type: 'string', default: 'us-east-1', requiresRestart: true },
    { key: 'prefix', label: 'Key prefix', description: 'Prepended to every path', type: 'string', default: '', requiresRestart: true },
    { key: 'endpoint', label: 'Endpoint', description: 'An S3-compatible service (MinIO); empty: AWS', type: 'string', default: '', requiresRestart: true },
    { key: 'accessKeyId', label: 'Access key id', description: 'Empty: the AWS default credential chain', type: 'secret', requiresRestart: true },
    { key: 'secretAccessKey', label: 'Secret access key', type: 'secret', requiresRestart: true },
    { key: 'readOnly', label: 'Read-only', description: 'Uploads, new folders and deletes are refused', type: 'boolean', default: true, requiresRestart: true },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    if (context.builder.fileStorageProvider) throw new Error('the filesystem storage is already set by the host or another plugin');
    const provider = await context.settings({
        title: 'Filesystem (S3)',
        description: 'An S3 or S3-compatible bucket served by the filesystem API',
        settings,
    });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    if (!text('bucket')) {
        return context.needsConfiguration(provider.missingRequired());
    }
    const storage = new S3FileStorageProvider({
        bucket: text('bucket'),
        region: text('region') || 'us-east-1',
        ...(text('prefix') ? { prefix: text('prefix') } : {}),
        ...(text('endpoint') ? { endpoint: text('endpoint') } : {}),
        ...(text('accessKeyId') && text('secretAccessKey') ? { credentials: { accessKeyId: text('accessKeyId'), secretAccessKey: text('secretAccessKey') } } : {}),
    });
    context.builder.setFileStorageProvider(provider.value('settings', 'readOnly') === false ? storage : readOnlyFileStorage(storage));
}
