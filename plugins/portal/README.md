# @qodalis/cli-server-plugin-portal

Portal plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node): your documentation site at one mount. It serves the prebuilt portal site (`@qodalis/cli-server-portal`), which shows the guides of the [docs plugin](../docs/README.md) and the API reference (code samples, "try it") of the [public-api plugin](../public-api/README.md), in one navigation; each section also works alone. Implements the same contract as the .NET (`Qodalis.Cli.Plugin.Portal`) and Python servers.

## Install

```bash
npm install @qodalis/cli-server-plugin-portal
```

## Usage

```typescript
import { CliDocsBuilder } from '@qodalis/cli-server-plugin-docs';
import { CliPublicApiBuilder } from '@qodalis/cli-server-plugin-public-api';
import { CliPortalBuilder } from '@qodalis/cli-server-plugin-portal';

const docs = new CliDocsBuilder().addFolder('docs').build();
const publicApi = new CliPublicApiBuilder().setUsers(users).setOpenApi('openapi.json').build();
const portal = new CliPortalBuilder()
    .setName('RateBell API')
    .setLogoUrl('/logo.svg')
    .setTheme({ mode: 'system', light: { primary: '#0a7' } })
    .addFooterLink({ label: 'Terms', url: 'https://example.com/terms' })
    .addSection(docs)
    .addSection(publicApi)
    .build();

cli.mountPlugin(docs);
cli.mountPlugin(publicApi);
cli.mountPlugin(portal); // http://host/qcli/portal
```

## Routes

The portal answers exactly these paths under its mount (GET and HEAD) and nothing else, so it can be mounted at `/` next to your own routes (`setPath('/')`): `GET /v1/rates` or `GET /health` are never shadowed, whatever the order they are registered in.

| Path | Answer |
|---|---|
| the mount, `/`, `/guides/<slug>`, `/reference`, `/reference/<tag>` | The site's `index.html` (`Cache-Control: no-cache`), its `<base href="/" />` rewritten to the mount |
| `/portal.json` | Which sections exist, with the name, logo, theme and footer links (below) |
| `/assets/<file>`, `/favicon.svg` | The site's files (`/assets/` cached for a year: their names change with each build); 404 when missing |

```json
{
  "name": "Documentation",
  "logo": null,
  "theme": { "mode": "system", "dark": {}, "light": {} },
  "footerLinks": [{ "label": "Terms", "url": "https://example.com/terms" }],
  "docs": { "title": "Guides", "pages": "/qcli/docs/pages" },
  "api": { "title": "API reference", "openapi": "/qcli/api/openapi.json", "swagger": "/qcli/api/swagger" }
}
```

`docs` and `api` are `null` when that plugin's section was not added (with neither, the site shows "Nothing published yet"). No sign-in is needed. On a protected server, mount the portal outside `/api` (the default `/qcli/portal` and `/` are): under `/api` the server's sign-in applies to the guide and reference pages.

When your app is mounted under a path (a parent Express app's `app.use('/prefix', cli.app)`), that prefix is added to the `portal.json` URLs and to `<base href>`. A prefix starting with `//` or `/\` (it would point them at another host) answers 400 `{ "error": "invalid path base" }` on the pages and `portal.json`.

## The site

The site is found, in order: `setSiteDir(dir)` (then only there), the sibling `cli-server-dashboard/portal/dist` (development), the copy bundled into this package (`site/`, made by `npm run build` / `prepublishOnly`), `../cli-server-dashboard/portal/dist` from the working directory, then the `@qodalis/cli-server-portal` package. Without one, `[qcli] portal site not found; the portal is not served` is logged once and nothing is served, `portal.json` included.

## Builder

| Method | Default | Description |
|---|---|---|
| `setPath(path)` | `/qcli/portal` | The mount: `/` or `/segment[/segment]` (`invalid portal path: <path>`) |
| `setName(name)` | `Documentation` | 1-80 characters without control characters |
| `setLogoUrl(url)` | none | An http(s) URL, a root-relative path or a base64 `data:image/…` URL (up to 200 000 characters) |
| `setTheme({ mode, dark, light })` | `system`, no colours | The admin dashboard's 21 colour tokens (`primary`, `background`, `text`, …), as the admin theme accepts them |
| `addFooterLink({ label, url })` | | At most 20; `label` 1-80 characters, `url` http(s) or root-relative |
| `addSection(plugin)` | | The docs or public-api plugin (its `portalSection`); one of each kind (`portal section already registered: <kind>`) |
| `setSiteDir(dir)` | resolved | The site's directory |
| `build()` | | `{ prefix, router, cliRoutes: false, publicRoutes, installedPlugin }`; throws on invalid options |
