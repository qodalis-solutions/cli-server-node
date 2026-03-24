/** Describes the author of a CLI command processor. */
export interface ICliCommandAuthor {
    /** Display name of the author. */
    name: string;
    /** Contact email of the author. */
    email: string;
}

/** Concrete implementation of {@link ICliCommandAuthor}. */
export class CliCommandAuthor implements ICliCommandAuthor {
    constructor(
        public name: string,
        public email: string,
    ) {}
}

/** Default author used for built-in library processors. */
export const DefaultLibraryAuthor: ICliCommandAuthor = new CliCommandAuthor(
    'Nicolae Lupei',
    'nicolae.lupei@qodalis.com',
);
