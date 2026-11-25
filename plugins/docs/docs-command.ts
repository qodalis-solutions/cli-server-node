import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliProcessCommand,
    getPositionals,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import { docsPageList, docsPageView, type DocsPage } from './docs-pages';

type Variables = () => ReadonlyMap<string, string>;

const jsonParam = new CliCommandParameterDescriptor('json', 'Print the result as JSON', false, 'boolean');
const groupParam = new CliCommandParameterDescriptor('group', 'Only the pages of this group', false, 'string');

class DocsListProcessor extends CliCommandProcessor {
    command = 'list';
    aliases = ['ls'];
    description = 'Lists the documentation pages by group: slug and title';
    parameters = [groupParam, jsonParam];
    examples = [
        { command: 'docs list', description: 'Every page' },
        { command: 'docs list --group Guides --json', description: 'The pages of one group as JSON' },
    ];

    constructor(
        private readonly pages: readonly DocsPage[],
        private readonly variables: Variables,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const group = command.args?.group;
        if (group === true || (group !== undefined && String(group).trim() === '')) return 'Error: --group needs a group name';
        let list = docsPageList(this.pages, this.variables());
        if (group !== undefined) list = list.filter((p) => p.group.toLowerCase() === String(group).toLowerCase());
        if (command.args?.json) return JSON.stringify(list, null, 2);
        if (list.length === 0) return group !== undefined ? `No documentation pages in the group ${group}.` : 'No documentation pages.';
        const width = Math.max(...list.map((p) => p.slug.length));
        // Grouped in the order each group first appears (the page order)
        const groups = new Map<string, typeof list>();
        for (const page of list) groups.set(page.group, [...(groups.get(page.group) ?? []), page]);
        const lines: string[] = [];
        for (const [name, pages] of groups) {
            if (lines.length) lines.push('');
            lines.push(name, ...pages.map((p) => `  ${p.slug.padEnd(width)}  ${p.title}`));
        }
        return lines.join('\n');
    }
}

class DocsReadProcessor extends CliCommandProcessor {
    command = 'read';
    aliases = ['show', 'cat'];
    description = 'Prints a documentation page as markdown, variables replaced';
    acceptsValue = true;
    parameters = [jsonParam];
    examples = [{ command: 'docs read getting-started', description: 'The page getting-started' }];

    constructor(
        private readonly bySlug: ReadonlyMap<string, DocsPage>,
        private readonly variables: Variables,
    ) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const words = getPositionals(command);
        if (words.length === 0) return 'Error: name the page: docs read <slug> (docs list shows them)';
        if (words.length > 1) return 'Error: one page at a time: docs read <slug>';
        const page = this.bySlug.get(words[0]);
        if (!page) return `Error: page not found: ${words[0]} (docs list shows the pages)`;
        const view = docsPageView(page, this.variables());
        if (command.args?.json) return JSON.stringify(view, null, 2);
        const markdown = view.markdown.trim();
        // The title lives in the front matter; shown as a heading unless the page starts with its own
        return markdown.startsWith('#') ? markdown : `# ${view.title}${markdown ? `\n\n${markdown}` : ''}`;
    }
}

/** `docs` (= `docs list`), `docs list [--group <g>] [--json]`, `docs read <slug> [--json]`: public like the pages. */
export class CliDocsCommandProcessor extends CliCommandProcessor {
    command = 'docs';
    description = 'Documentation pages: list them, read one as markdown';
    module = 'docs';
    icon = '📖';
    processors: ICliCommandProcessor[];
    private readonly list: DocsListProcessor;

    constructor(pages: readonly DocsPage[], bySlug: ReadonlyMap<string, DocsPage>, variables: Variables) {
        super();
        this.list = new DocsListProcessor(pages, variables);
        this.processors = [this.list, new DocsReadProcessor(bySlug, variables)];
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.list.handleAsync(command);
    }
}
