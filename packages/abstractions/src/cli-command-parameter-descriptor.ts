/** Describes a parameter accepted by a CLI command processor. */
export interface ICliCommandParameterDescriptor {
    /** Parameter name (e.g. "algorithm"). */
    name: string;
    /** Short alias flags (e.g. ["-a"]). */
    aliases?: string[];
    /** Human-readable description shown in help output. */
    description: string;
    /** Whether the parameter must be provided. */
    required: boolean;
    /** Expected value type (e.g. "string", "boolean", "number"). */
    type: string;
    /** Default value used when the parameter is omitted. */
    defaultValue?: any;
}

/** Concrete implementation of {@link ICliCommandParameterDescriptor}. */
export class CliCommandParameterDescriptor implements ICliCommandParameterDescriptor {
    /**
     * @param name - Parameter name.
     * @param description - Human-readable description.
     * @param required - Whether the parameter is mandatory.
     * @param type - Expected value type.
     * @param aliases - Short alias flags.
     * @param defaultValue - Default value when omitted.
     */
    constructor(
        public name: string,
        public description: string,
        public required: boolean = false,
        public type: string = 'string',
        public aliases?: string[],
        public defaultValue?: any,
    ) {}
}
