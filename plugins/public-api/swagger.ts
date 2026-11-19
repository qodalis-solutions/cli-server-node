import { dirname, join } from 'path';
import { Request, Response, NextFunction } from 'express';

/** The `swagger-ui-dist` files the page loads; nothing else of the package is served. */
export const SWAGGER_ASSETS = ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'favicon-32x32.png'] as const;

const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A JSON value safe inside an inline `<script>`. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Swagger UI 5 for `<basePath>/openapi.json` only. */
export function swaggerPage(basePath: string, title: string): string {
    const assets = `${basePath}/swagger/assets`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${assets}/swagger-ui.css" />
<link rel="icon" type="image/png" href="${assets}/favicon-32x32.png" />
</head>
<body>
<div id="swagger-ui"></div>
<script src="${assets}/swagger-ui-bundle.js"></script>
<script src="${assets}/swagger-ui-standalone-preset.js"></script>
<script>
window.ui = SwaggerUIBundle({ url: ${scriptJson(`${basePath}/openapi.json`)}, dom_id: '#swagger-ui', persistAuthorization: false, tryItOutEnabled: true });
</script>
</body>
</html>
`;
}

/** The `swagger-ui-dist` directory, or null when the package is not installed. */
export function swaggerUiDir(): string | null {
    try {
        return dirname(require.resolve('swagger-ui-dist/package.json'));
    } catch {
        return null;
    }
}

/** Serves the whitelisted Swagger UI files (`GET /swagger/assets/:file`); anything else falls through. */
export function swaggerAssets(dir: string | null) {
    const allowed = new Set<string>(SWAGGER_ASSETS);
    return (req: Request, res: Response, next: NextFunction) => {
        const file = req.params.file;
        if (!dir || !allowed.has(file)) {
            next();
            return;
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(join(dir, file), (err) => {
            if (err && !res.headersSent) next();
        });
    };
}
