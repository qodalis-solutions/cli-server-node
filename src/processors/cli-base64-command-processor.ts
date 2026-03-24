import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';

/** Sub-processor that encodes text to Base64. */
class Base64EncodeProcessor extends CliCommandProcessor {
    command = 'encode';
    description = 'Encodes text to Base64';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const text = command.value;
        if (!text) return 'Usage: base64 encode <text>';
        return Buffer.from(text, 'utf8').toString('base64');
    }
}

/** Sub-processor that decodes Base64 to text. */
class Base64DecodeProcessor extends CliCommandProcessor {
    command = 'decode';
    description = 'Decodes Base64 to text';

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const text = command.value;
        if (!text) return 'Usage: base64 decode <base64string>';
        try {
            return Buffer.from(text, 'base64').toString('utf8');
        } catch {
            return 'Error: Invalid Base64 input';
        }
    }
}

/** Command processor for Base64 encoding and decoding with `encode` and `decode` sub-commands. */
export class CliBase64CommandProcessor extends CliCommandProcessor {
    command = 'base64';
    description = 'Encodes or decodes Base64 text';
    allowUnlistedCommands = false;
    processors: ICliCommandProcessor[] = [new Base64EncodeProcessor(), new Base64DecodeProcessor()];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return 'Usage: base64 encode|decode <text>';
    }
}
