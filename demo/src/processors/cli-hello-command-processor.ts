import { CliCommandProcessor, CliCommandParameterDescriptor, CliProcessCommand, getPositionalText } from '@qodalis/cli-server-node';

export class CliHelloCommandProcessor extends CliCommandProcessor {
    command = 'hello';
    acceptsValue = true;
    description = 'Greets the user';

    parameters = [
        new CliCommandParameterDescriptor('name', 'Name to greet', false, 'string', ['-n'], 'World'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const name = command.args?.name?.toString() ?? (getPositionalText(command) || 'World');
        return `Hello, ${name}!`;
    }
}
