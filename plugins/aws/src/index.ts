export { AwsModule } from './aws-module';
export { AwsCommandProcessor } from './aws-command-processor';
export { AwsConfigService } from './services/aws-config-service';
export { AwsCredentialManager } from './services/aws-credential-manager';
export { AwsPermissions, AWS_PERMISSION_ENTRIES } from './permissions';
/** The plugin's entry point (`builder.addPlugin(awsPluginEntry, options)`; what the marketplace loads). */
export * as awsPluginEntry from './plugin';
