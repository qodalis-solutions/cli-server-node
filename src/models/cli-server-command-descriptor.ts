/** Serializable DTO describing a command parameter for API responses. */
export interface CliServerCommandParameterDescriptorDto {
    name: string;
    aliases?: string[];
    description: string;
    required: boolean;
    type: string;
    defaultValue?: any;
    /** The only values the parameter takes. */
    allowedValues?: string[];
    /** Example values. */
    examples?: string[];
}

/** An example command line in a command's help. */
export interface CliServerCommandExampleDto {
    command: string;
    description?: string;
}

/** Serializable DTO describing a registered command processor for API responses. */
export interface CliServerCommandDescriptor {
    command: string;
    description?: string;
    version?: string;
    /** Other names of the command. */
    aliases?: string[];
    /** Example command lines. */
    examples?: CliServerCommandExampleDto[];
    /** Longer help text (paragraphs separated by a blank line). */
    documentation?: string;
    /** The group the command is listed under in help. */
    module?: string;
    /** One emoji for help. */
    icon?: string;
    parameters?: CliServerCommandParameterDescriptorDto[];
    processors?: CliServerCommandDescriptor[];
}
