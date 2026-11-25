/**
 * The entry point of the docs plugin installed at runtime (`qodalis.entry`): Markdown guides served at `basePath`
 * (default `/qcli/docs`), read from a folder (default `<dataDir>/plugin-data/docs/pages`, created) and the `docs`
 * command. The folder, path, title and name are settings (a restart applies them).
 */
import { mkdirSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliDocsBuilder, DEFAULT_DOCS_BASE_PATH, DEFAULT_DOCS_NAME, DEFAULT_DOCS_TITLE } from './cli-docs-builder';

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const settings = await context.settings({
        title: 'Docs',
        description: 'Markdown guides served by the server',
        settings: [
            { key: 'folder', label: 'Folder', description: "The Markdown files (relative paths from the plugin's data directory)", type: 'string', default: 'pages', requiresRestart: true, validation: { required: true, max: 500 } },
            { key: 'basePath', label: 'Path', description: 'Where the guides are served', type: 'string', default: DEFAULT_DOCS_BASE_PATH, requiresRestart: true, validation: { required: true, pattern: '^(/[A-Za-z0-9._~-]+)+$' } },
            { key: 'title', label: 'Title', type: 'string', default: DEFAULT_DOCS_TITLE, requiresRestart: true, validation: { required: true, max: 100 } },
            { key: 'name', label: 'Name', type: 'string', default: DEFAULT_DOCS_NAME, requiresRestart: true, validation: { required: true, max: 100 } },
        ],
    });
    const text = (key: string) => String(settings.value('settings', key) ?? '').trim();
    const folder = isAbsolute(text('folder')) ? text('folder') : join(context.dataDir, text('folder') || 'pages');
    mkdirSync(folder, { recursive: true });
    return new CliDocsBuilder()
        .setBasePath(text('basePath') || DEFAULT_DOCS_BASE_PATH)
        .setTitle(text('title') || DEFAULT_DOCS_TITLE)
        .setName(text('name') || DEFAULT_DOCS_NAME)
        .addFolder(folder)
        .build();
}
