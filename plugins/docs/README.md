# @qodalis/cli-server-plugin-docs

Docs plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node): markdown guides from folders or code, with front matter and variables, served as JSON. The [portal plugin](../portal/README.md) shows them as the guides of your documentation site. Implements the same contract as the .NET (`Qodalis.Cli.Plugin.Docs`) and Python servers.

## Install

```bash
npm install @qodalis/cli-server-plugin-docs
```

## Usage

```typescript
import { CliDocsBuilder } from '@qodalis/cli-server-plugin-docs';

const docs = new CliDocsBuilder()
    .setName('RateBell API')
    .setVariable('support', 'help@ratebell.app')
    .addFolder('docs') // relative to the working directory
    .addPage('errors', '# Errors\nEvery error is `{ "error": "<text>" }`.')
    .build();

cli.mountPlugin(docs);
```

## Pages

- **Folders:** every `*.md` file directly in the folder (no subfolders; names starting with `.` or `_` are skipped). The slug is the file name without `.md`, lower-cased, and must match `^[a-z0-9][a-z0-9-]*$`. `index` is the guides' home page. Folders are read once, by `build()`.
- **Front matter:** only when the first line is exactly `---`, up to the next line that is exactly `---` (without one the whole file is the body). Lines `key: value` with `title`, `group` and `order` (an integer); other keys are ignored and quotes around a value are removed. The front matter is not part of the served markdown.
- **Defaults:** `title` is the first `# ` heading of the body, else the slug; `group` is `Guides`; `order` is 0. Pages are ordered by `order`, then `title` (case-insensitive), then `slug`.
- **Variables:** `{{ key }}` in titles and pages is replaced per request; unknown keys stay as written. Built in: `baseUrl` (`setBaseUrl`, else the request's `scheme://host`) and `name` (`setName`, default `Documentation`). Add your own with `setVariable(key, value)`.

```markdown
---
title: Welcome to {{name}}
order: 1
---
Call {{ baseUrl }}/v1/rates with your API token.
```

## API

No sign-in; credentials are ignored (the pages stay public on a protected server).

| Method | Path | Answer |
|---|---|---|
| GET | `/qcli/docs/pages` | `[{ slug, title, group, order }]` in page order, `Cache-Control: no-cache` |
| GET | `/qcli/docs/pages/<slug>` | `{ slug, title, group, order, markdown }`, `Cache-Control: no-cache`; 404 `{ "error": "page not found" }` for an unknown slug |

## Builder

| Method | Default | Description |
|---|---|---|
| `setBasePath(path)` | `/qcli/docs` | Where the pages are served (`/segment[/segment]`) |
| `setTitle(title)` | `Guides` | The portal's label for the guides |
| `setName(name)` | `Documentation` | The `{{name}}` variable |
| `setBaseUrl(url)` | the request's `scheme://host` | The `{{baseUrl}}` variable |
| `setVariable(key, value)` | | A host variable (`^[A-Za-z][A-Za-z0-9_.-]*$`) |
| `addFolder(path)` | | Pages from a folder |
| `addPage(slug, markdown)` | | A page in code |
| `build()` | | `{ prefix, router, cliRoutes: false, publicRoutes, pages, portalSection, installedPlugin }` |

`build()` throws on: `invalid docs base path: <path>`, `invalid docs page name: <file>`, `invalid docs page slug: <slug>`, `duplicate docs page: <slug>`, `docs folder not found: <path>`, `invalid order in docs page: <slug>`, `invalid docs variable: <key>`, `docs variable is built in: <key>`.
