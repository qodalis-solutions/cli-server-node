import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliProcessCommand,
    ICliCommandProcessor,
} from '@qodalis/cli-server-node';

class CliMathAddProcessor extends CliCommandProcessor {
    command = 'add';
    description = 'Adds two numbers';

    parameters = [
        new CliCommandParameterDescriptor('a', 'First number', true, 'number'),
        new CliCommandParameterDescriptor('b', 'Second number', true, 'number'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const a = Number(command.args?.a);
        const b = Number(command.args?.b);

        if (isNaN(a) || isNaN(b)) {
            return 'Error: --a and --b must be numbers';
        }

        return `${a} + ${b} = ${a + b}`;
    }
}

class CliMathMultiplyProcessor extends CliCommandProcessor {
    command = 'multiply';
    description = 'Multiplies two numbers';

    parameters = [
        new CliCommandParameterDescriptor('a', 'First number', true, 'number'),
        new CliCommandParameterDescriptor('b', 'Second number', true, 'number'),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const a = Number(command.args?.a);
        const b = Number(command.args?.b);

        if (isNaN(a) || isNaN(b)) {
            return 'Error: --a and --b must be numbers';
        }

        return `${a} * ${b} = ${a * b}`;
    }
}

export class CliMathCommandProcessor extends CliCommandProcessor {
    command = 'math';
    description = 'Performs basic math operations';
    allowUnlistedCommands = false;

    processors: ICliCommandProcessor[] = [
        new CliMathAddProcessor(),
        new CliMathMultiplyProcessor(),
    ];

    async handleAsync(_command: CliProcessCommand): Promise<string> {
        return 'Usage: math add|multiply --a <number> --b <number>';
    }
}
