import { existsSync } from 'fs';
import { resolve } from 'path';
import type { Request, Response } from 'express';
import type { CliServerResult } from '@qodalis/cli-server-node';
import type { UsersPluginResult } from '@qodalis/cli-server-plugin-users';
import { CliPublicApiBuilder, PublicApiPluginResult } from '@qodalis/cli-server-plugin-public-api';
import { CliDocsBuilder, DocsPluginResult } from '@qodalis/cli-server-plugin-docs';
import { CliPortalBuilder, PortalPluginResult } from '@qodalis/cli-server-plugin-portal';

/** The demo's public API, as an OpenAPI document (Express has no route metadata). */
export const DEMO_OPENAPI = {
    openapi: '3.1.0',
    info: { title: 'Qodalis CLI demo API', version: '1.0.0', description: 'A public route of the demo server, called with a host token.' },
    paths: {
        '/v1/demo/time': {
            get: {
                tags: ['Demo'],
                operationId: 'getTime',
                summary: 'The server time',
                'x-required-permission': 'demo:read',
                responses: {
                    '200': {
                        description: 'The current UTC time',
                        content: {
                            'application/json': {
                                schema: { type: 'object', properties: { utc: { type: 'string', format: 'date-time' } }, required: ['utc'] },
                            },
                        },
                    },
                    '401': { description: 'No or an invalid token' },
                    '403': { description: 'Not a host token, or the token lacks demo:read' },
                    '429': { description: 'Over the daily or per-minute limit' },
                },
            },
        },
    },
};

/** The demo's guides: `demo/docs`, whether the demo runs from its folder, the repo root or its build. */
function docsFolder(): string {
    const candidates = [resolve(__dirname, '..', 'docs'), resolve(process.cwd(), 'docs'), resolve(process.cwd(), 'demo', 'docs')];
    return candidates.find((dir) => existsSync(resolve(dir, 'index.md'))) ?? candidates[0];
}

export interface DemoPublicApi {
    publicApi: PublicApiPluginResult;
    docs: DocsPluginResult;
    portal: PortalPluginResult;
}

/**
 * A public API next to the CLI: `GET /v1/demo/time` for host tokens holding `demo:read`
 * (1000 requests a day, 60 a minute per account), its OpenAPI document and Swagger UI at
 * `/qcli/api`, guides at `/qcli/docs` and the portal showing both at `/qcli/portal`.
 */
export function addPublicApi(server: Pick<CliServerResult, 'app' | 'builder' | 'mountPlugin'>, users: UsersPluginResult): DemoPublicApi {
    server.builder.addPermissions([{ name: 'demo:read', description: 'The demo public API (GET /v1/demo/time)', group: 'Demo' }]);

    const publicApi = new CliPublicApiBuilder()
        .setUsers(users)
        .setOpenApi(DEMO_OPENAPI)
        .setQuota(() => ({ requestsPerDay: 1000, requestsPerMinute: 60 }))
        .build();
    const docs = new CliDocsBuilder().setName('Qodalis CLI demo API').addFolder(docsFolder()).build();
    const portal = new CliPortalBuilder()
        .setName('Qodalis CLI demo')
        .addFooterLink({ label: 'Qodalis CLI', url: 'https://cli.qodalis.com' })
        .addSection(docs)
        .addSection(publicApi)
        .build();

    server.mountPlugin(publicApi);
    server.mountPlugin(docs);
    server.mountPlugin(portal);
    server.app.get('/v1/demo/time', publicApi.guard('demo:read'), (_req: Request, res: Response) => {
        res.json({ utc: new Date().toISOString() });
    });
    return { publicApi, docs, portal };
}
