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

The portal answers these paths under its mount (GET and HEAD). Away from `/` it also answers every other path under `assets/`, `guides/` and `reference/` with its own 404 `{ "error": "not found" }`; anything else under the mount falls through to your routes. At a root mount (`setPath('/')`) only the paths below are the portal's, and an unknown or missing one falls through, so `GET /v1/rates` or `GET /health` are never shadowed, whatever the order they are registered in.

| Path | Answer |
|---|---|
| the mount, `/`, `/guides/<slug>`, `/reference`, `/reference/<tag>` | The site's `index.html` (`Cache-Control: no-cache`), its `<base href="/" />` rewritten to the mount |
| `/portal.json` | Which sections exist, with the name, logo, theme and footer links (below) |
| `/assets/<file>`, `/favicon.svg` | The site's files (`/assets/` cached for a year: their names change with each build). A missing asset: the portal's 404 `{ "error": "not found" }` away from `/`, falls through to your routes at a root mount; a missing `favicon.svg` always falls through |

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

`docs` and `api` are `null` when that plugin's section was not added (with neither, the site shows "Nothing published yet"). No sign-in is needed, on a protected server too, under `/api` as well: the portal declares its pages, `portal.json`, `/assets/*`, `/guides/*` and `/reference/*` as public routes. The server hands such requests to the portal alone, never to one of your routes or a CLI route, and every path under those prefixes the portal does not serve is its own 404 `{ "error": "not found" }` (at a root mount, unknown paths still fall through to your routes).

On a protected server, a request to a public route of the portal, docs or public-api plugin under `/api` is answered inside the server's auth gate, which runs first. Middleware you add to the app after `createCliServer` (a rate limiter, request logging, compression) does not run for it; add such middleware before the CLI server's app, for example on a parent app (`outer.use(limiter); outer.use(cli.app)`).

**The mount must be a path your app does not use for its own routes.** A mount holding the CLI's routes or inside them (`/api`, `/ws`, `/api/v1`, `/api/v1/qcli/...`) is refused with `invalid portal path: <path>`.

When your app is mounted under a path (a parent Express app's `app.use('/prefix', cli.app)`), that prefix is added to the `portal.json` URLs and to `<base href>`. A prefix starting with `//` or `/\`, or holding whitespace or control characters (it would point them at another host) answers 400 `{ "error": "invalid path base" }` on the pages and `portal.json`.

## The site

The site is found as on the .NET server: `setSiteDir(dir)` alone when given (no other location is tried); otherwise the installed `@qodalis/cli-server-portal` package, then the sibling `cli-server-dashboard/portal/dist` (only when this package is inside a git checkout of cli-server-node, never next to an installed package), then the copy bundled into this package (`site/`, made by `npm run build`; `prepublishOnly` fails when there is no site to bundle). Without one, `[qcli] portal site not found; the portal is not served` is logged once and nothing is served, `portal.json` included.

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
| `build()` | | `{ prefix, router, cliRoutes: false, publicRoutes, installedPlugin, configProviders, module, status() }`; throws on invalid options |

## Terminal commands

`portal`, registered by `mountPlugin`. It needs `config:read` on a protected server: it shows the portal's settings, as
`config get portal` does (the portal itself stays public). The site's content comes from the
[docs plugin](../docs/README.md#terminal-commands) (`docs list`, `docs read`) and the
[public-api plugin](../public-api/README.md#terminal-commands) (`api usage`).

| Command | Permission | Does |
|---|---|---|
| `portal`, `portal status [--json]` | `config:read` | The mount, whether the site was found and where from, the sections (docs with its page count, the API's title and OpenAPI URL) and the current branding |

```text
$ portal
Portal: /qcli/portal
Site: found, @qodalis/cli-server-portal (/app/node_modules/@qodalis/cli-server-portal/dist)
Sections:
  docs  Guides, 12 pages (/qcli/docs/pages)
  api   API reference (/qcli/api/openapi.json)
Branding:
  name         RateBell API
  logoUrl      /logo.svg
  themeMode    system
  footerLinks  Terms (https://example.com/terms)

Change the branding with config set portal.branding.<key> <value> (name, logoUrl, themeMode, footerLinks).
```

Where the site came from: `setSiteDir`, `@qodalis/cli-server-portal`, `cli-server-dashboard/portal/dist` or
`bundled with the plugin`; without one, `Site: not found, the portal is not served (...)`. Without sections:
`Sections: none (the site shows "Nothing published yet")`.

`--json` prints `portal.json` (with the current branding; `docs` adds `pageCount`) and the site:

```json
{
  "name": "RateBell API",
  "logo": "/logo.svg",
  "theme": { "mode": "system", "dark": {}, "light": {} },
  "footerLinks": [{ "label": "Terms", "url": "https://example.com/terms" }],
  "docs": { "title": "Guides", "pages": "/qcli/docs/pages", "pageCount": 12 },
  "api": { "title": "API reference", "openapi": "/qcli/api/openapi.json", "swagger": "/qcli/api/swagger" },
  "site": { "path": "/qcli/portal", "found": true, "source": "package", "dir": "/app/node_modules/@qodalis/cli-server-portal/dist" }
}
```

`site.source` is `siteDir`, `package`, `checkout`, `bundled`, or `null` when the site was not found.

## Configuration

The plugin brings the `portal` config provider (the server's [config providers](../../README.md)): the branding
changes at runtime, through `config set`, the dashboard's Settings page or `PATCH /api/v1/qcli/config/portal/branding`
(`config:write`). The builder's values are the defaults, stored values override them, and every change is in the next
`/portal.json`, no restart. `null` (`config reset`) brings the builder's value back. Changes are kept in the server's
default config store, or in the provider's own with `setConfigStore(store)` on the builder.

| Setting | Type | Rules |
|---|---|---|
| `portal.branding.name` | string | 1-80 characters without control characters |
| `portal.branding.logoUrl` | string | An http(s) URL, a root-relative path or a base64 `data:image/…` URL (up to 200 000 characters), as `setLogoUrl` checks it; `''` for no logo. A `string` rather than a `url`: a `url` setting must be absolute |
| `portal.branding.themeMode` | enum | `system`, `light` or `dark` |
| `portal.branding.footerLinks` | json | A list of at most 20 `{ "label", "url" }` links, as `addFooterLink` checks them |
| `portal.site.path`, `.siteFound`, `.sections` | read-only | The mount, whether the site was found, the sections added (`docs`, `api`) |

```text
$ config set portal.branding.name "RateBell API"
$ config set portal.branding.themeMode dark
$ config set portal.branding.footerLinks '[{"label":"Terms","url":"https://example.com/terms"}]'
$ config reset portal.branding.logoUrl
```

The theme's colour tokens (`setTheme({ dark, light })`) stay in code: 21 tokens per scheme would make a long settings
page, and a wrong colour is easier to catch in review.

## Install from the dashboard

Not installable at runtime: its package declares `"autoInstall": false` (a developer portal whose sections come from the host's public API and docs plugins), so the marketplace and the
dashboard list it with "needs setup in code" and `admin plugins install portal` refuses it. Set it up in code as shown
above.
