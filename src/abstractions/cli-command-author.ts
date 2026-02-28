export interface ICliCommandAuthor {
    name: string;
    email: string;
}

export class CliCommandAuthor implements ICliCommandAuthor {
    constructor(
        public name: string,
        public email: string,
    ) {}
}

export const DefaultLibraryAuthor: ICliCommandAuthor = new CliCommandAuthor(
    'Nicolae Lupei',
    'nicolae.lupei@qodalis.com',
);
