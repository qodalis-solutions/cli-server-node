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
    /**
     * The only values the parameter takes. Clients show them in help, offer them in completion
     * and check them before sending (ignoring case); MCP lists them as the property's `enum`.
     */
    allowedValues?: string[];
    /** Example values (e.g. `["Paris", "New York"]`): shown in help; MCP lists them as the property's `examples`. */
    examples?: string[];
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
     * @param allowedValues - The only values the parameter takes.
     * @param examples - Example values.
     */
    constructor(
        public name: string,
        public description: string,
        public required: boolean = false,
        public type: string = 'string',
        public aliases?: string[],
        public defaultValue?: any,
        public allowedValues?: string[],
        public examples?: string[],
    ) {}
}
