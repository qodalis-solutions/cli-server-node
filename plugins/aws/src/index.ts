import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { AwsCommandProcessor } from './aws-command-processor';
import { CLI_INSTALLED_PLUGIN } from '@qodalis/cli-server-abstractions';
import { awsInstalledPlugin } from './package-info';

export class AwsModule extends CliModule {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = awsInstalledPlugin;

    name = 'aws';
    version = '1.0.0';
    description = 'AWS cloud resource management';
    processors: ICliCommandProcessor[];

    constructor() {
        super();
        this.processors = [new AwsCommandProcessor()];
    }
}

export { AwsCommandProcessor } from './aws-command-processor';
export { AwsConfigService } from './services/aws-config-service';
export { AwsCredentialManager } from './services/aws-credential-manager';
