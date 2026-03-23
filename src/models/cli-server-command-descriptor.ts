/** Serializable DTO describing a command parameter for API responses. */
export interface CliServerCommandParameterDescriptorDto {
    name: string;
    aliases?: string[];
    description: string;
    required: boolean;
    type: string;
    defaultValue?: any;
}

/** Serializable DTO describing a registered command processor for API responses. */
export interface CliServerCommandDescriptor {
    command: string;
    description?: string;
    version?: string;
    apiVersion?: number;
    parameters?: CliServerCommandParameterDescriptorDto[];
    processors?: CliServerCommandDescriptor[];
}
