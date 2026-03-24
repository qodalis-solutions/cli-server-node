import crypto from 'crypto';
import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliCommandParameterDescriptor } from '../abstractions/cli-command-parameter-descriptor';
import { CliProcessCommand } from '../abstractions/cli-process-command';

const SUPPORTED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];

/** Command processor that computes cryptographic hashes (md5, sha1, sha256, sha512) of input text. */
export class CliHashCommandProcessor extends CliCommandProcessor {
    command = 'hash';
    description = 'Computes hash of the input text';
    parameters = [
        new CliCommandParameterDescriptor(
            'algorithm',
            `Hash algorithm (${SUPPORTED_ALGORITHMS.join(', ')})`,
            false,
            'string',
            ['-a'],
            'sha256',
        ),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const text = command.value;
        if (!text) return 'Usage: hash <text> [--algorithm sha256]';

        const algo = ((command.args?.algorithm as string) ?? 'sha256').toLowerCase();
        if (!SUPPORTED_ALGORITHMS.includes(algo)) {
            return `Unsupported algorithm: ${algo}. Supported: ${SUPPORTED_ALGORITHMS.join(', ')}`;
        }

        const digest = crypto.createHash(algo).update(text, 'utf8').digest('hex');
        return `${algo}: ${digest}`;
    }
}
