/**
 * The entry point of the AWS plugin installed at runtime (`qodalis.entry`): the `aws` commands. The region, profile and
 * access keys are settings (the keys `secret` settings: kept server-side, never returned), applied at start; without
 * keys the AWS default credential chain is used. `aws configure set` still changes them until the next restart.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { AwsModule } from './aws-module';
import { AwsCommandProcessor } from './aws-command-processor';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'aws', package: '@qodalis/cli-server-plugin-aws', title: 'AWS', icon: '☁️' };

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'region', label: 'Region', description: 'e.g. eu-north-1; empty: the default chain', type: 'string', default: '', requiresRestart: true },
    { key: 'profile', label: 'Profile', description: 'A profile of the shared AWS config; empty: none', type: 'string', default: '', requiresRestart: true },
    { key: 'accessKeyId', label: 'Access key id', description: 'Empty: the AWS default credential chain', type: 'secret', requiresRestart: true },
    { key: 'secretAccessKey', label: 'Secret access key', type: 'secret', requiresRestart: true },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'AWS',
        description: 'The aws commands: region and credentials',
        settings,
    });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const module = new AwsModule();
    const aws = module.processors.find((p): p is AwsCommandProcessor => p instanceof AwsCommandProcessor);
    const config = aws?.getConfigService();
    if (config) {
        if (text('region')) config.setRegion(text('region'));
        if (text('profile')) config.setProfile(text('profile'));
        if (text('accessKeyId') && text('secretAccessKey')) config.setCredentials(text('accessKeyId'), text('secretAccessKey'));
    }
    return module;
}
