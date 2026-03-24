import { CliModule, ICliCommandProcessor } from '@qodalis/cli-server-abstractions';
import { AwsCommandProcessor } from './aws-command-processor';

export class AwsModule extends CliModule {
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
