import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand } from '@qodalis/cli-server-node';

export class CliHelloCommandProcessor extends CliCommandProcessor {
    command = 'hello';
    description = 'Greets the user';

    parameters = [
        new CliCommandParameterDescriptor('name', 'Name to greet', false, 'string', ['-n'], 'World'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const name = command.args?.name?.toString() ?? command.value ?? 'World';
        return `Hello, ${name}!`;
    }
}
