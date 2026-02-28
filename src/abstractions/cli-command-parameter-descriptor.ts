export interface ICliCommandParameterDescriptor {
    name: string;
    aliases?: string[];
    description: string;
    required: boolean;
    type: string;
    defaultValue?: any;
}

export class CliCommandParameterDescriptor implements ICliCommandParameterDescriptor {
    constructor(
        public name: string,
        public description: string,
        public required: boolean = false,
        public type: string = 'string',
        public aliases?: string[],
        public defaultValue?: any,
    ) {}
}
