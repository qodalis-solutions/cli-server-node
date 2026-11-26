import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { AwsCommandProcessor } from './aws-command-processor';
import { CLI_INSTALLED_PLUGIN } from '@qodalis/cli-server-abstractions';
import { awsInstalledPlugin } from './package-info';
import { AWS_PERMISSION_ENTRIES } from './permissions';

export class AwsModule extends CliModule {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = awsInstalledPlugin;

    name = 'aws';
    version = '1.0.0';
    description = 'AWS cloud resource management';
    icon = '☁️';
    processors: ICliCommandProcessor[];
    /** `aws:read` and `aws:write`, added to the server's permission catalog (group AWS). */
    permissions = AWS_PERMISSION_ENTRIES;

    constructor() {
        super();
        this.processors = [new AwsCommandProcessor()];
    }
}
