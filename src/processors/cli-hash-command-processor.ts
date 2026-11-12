import crypto from 'crypto';
import { CliCommandProcessor } from '../abstractions/cli-command-processor';
import { CliCommandParameterDescriptor } from '../abstractions/cli-command-parameter-descriptor';
import { CliProcessCommand } from '../abstractions/cli-process-command';
import { getPositionalText } from '../abstractions';

const SUPPORTED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];

/** Command processor that computes cryptographic hashes (md5, sha1, sha256, sha512) of input text. */
export class CliHashCommandProcessor extends CliCommandProcessor {
    command = 'hash';
    description = 'Computes hash of the input text';
    examples = [
        { command: 'hash hello', description: 'SHA-256 digest of hello' },
        { command: 'hash hello --algorithm md5', description: 'MD5 digest of hello' },
    ];
    documentation =
        'Computes a digest of the text on the server and prints it in hexadecimal. The default algorithm is sha256.';
    acceptsValue = true;
    parameters = [
        new CliCommandParameterDescriptor(
            'algorithm',
            `Hash algorithm (${SUPPORTED_ALGORITHMS.join(', ')})`,
            false,
            'string',
            ['-a'],
            'sha256',
            SUPPORTED_ALGORITHMS,
        ),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const text = getPositionalText(command);
        if (!text) return 'Usage: hash <text> [--algorithm sha256]';

        const algo = ((command.args?.algorithm as string) ?? 'sha256').toLowerCase();
        if (!SUPPORTED_ALGORITHMS.includes(algo)) {
            return `Unsupported algorithm: ${algo}. Supported: ${SUPPORTED_ALGORITHMS.join(', ')}`;
        }

        const digest = crypto.createHash(algo).update(text, 'utf8').digest('hex');
        return `${algo}: ${digest}`;
    }
}
