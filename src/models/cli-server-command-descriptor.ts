export interface CliServerCommandParameterDescriptorDto {
    name: string;
    aliases?: string[];
    description: string;
    required: boolean;
    type: string;
    defaultValue?: any;
}

export interface CliServerCommandDescriptor {
    command: string;
    description?: string;
    version?: string;
    parameters?: CliServerCommandParameterDescriptorDto[];
    processors?: CliServerCommandDescriptor[];
}
