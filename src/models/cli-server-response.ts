import { CliServerOutput } from './cli-server-output';

export interface CliServerResponse {
    exitCode: number;
    outputs: CliServerOutput[];
}
