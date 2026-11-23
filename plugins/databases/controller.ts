import { Router, Request, Response, NextFunction, json } from 'express';
import { CliMigrationError, type CliMigrationRunOptions } from './runner';
import type { CliDatabases } from './databases';

/** Permissions of the databases API (declared as route permissions; a protected server enforces them). */
export const DatabasesPermissions = {
    Read: 'databases:read',
    Migrate: 'databases:migrate',
} as const;

function callerName(req: Request): string | undefined {
    return (req as Request & { qcliServerAuth?: { userName?: string } }).qcliServerAuth?.userName;
}

/**
 * `GET /` databases, `GET /:db` one of them, `GET /:db/stats`, `GET /:db/migrations`, `GET /:db/migrations/runs`,
 * `GET /:db/migrations/sql` (dry run), `POST /:db/migrations/up`, `POST /:db/migrations/down`. Errors answer
 * `{ error }`: 404 unknown database or migration, 409 busy or blocked.
 */
export function createDatabasesController(databases: CliDatabases): Router {
    const router = Router();
    router.use(json({ limit: '16kb' }));
    const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
    const runner = (req: Request) => {
        const db = databases.database(req.params.db);
        if (!db) throw new CliMigrationError(`unknown database: ${req.params.db}`, 404);
        return db;
    };
    const text = (value: unknown, name: string): string | undefined => {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' || value.length > 200) throw new CliMigrationError(`${name} must be a migration id`, 400);
        return value;
    };

    router.get('/', wrap(async (_req, res) => {
        res.json({ databases: await databases.overview() });
    }));

    router.get('/:db', wrap(async (req, res) => {
        res.json(await databases.summary(runner(req)));
    }));

    router.get('/:db/stats', wrap(async (req, res) => {
        res.json(await databases.stats(runner(req).name));
    }));

    router.get('/:db/migrations', wrap(async (req, res) => {
        const db = runner(req);
        res.json({ name: db.name, dialect: db.dialect, sources: db.sourceNames, migrations: await db.status() });
    }));

    router.get('/:db/migrations/runs', wrap(async (req, res) => {
        const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
        const page = Math.max(1, Number(req.query.page) || 1);
        res.json(await runner(req).runs(size, (page - 1) * size));
    }));

    router.get('/:db/migrations/sql', wrap(async (req, res) => {
        const db = runner(req);
        const direction = req.query.direction === 'down' ? 'down' : 'up';
        const to = text(req.query.to, 'to');
        if (direction === 'down' && !to) throw new CliMigrationError('to is required to roll back (an id, or base for everything)', 400);
        const result = direction === 'up' ? await db.up({ to, dryRun: true }) : await db.down({ to: to!, dryRun: true });
        res.json(result);
    }));

    const run = (direction: 'up' | 'down') =>
        wrap(async (req, res) => {
            const body = (req.body ?? {}) as { to?: unknown; force?: unknown };
            const options: CliMigrationRunOptions = {
                to: text(body.to, 'to'),
                force: body.force === true,
                actor: callerName(req),
                trigger: 'api',
            };
            if (direction === 'down' && !options.to) throw new CliMigrationError('to is required to roll back (an id, or base for everything)', 400);
            res.json(await databases.run(req.params.db, direction, options));
        });
    router.post('/:db/migrations/up', run('up'));
    router.post('/:db/migrations/down', run('down'));

    router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (err instanceof CliMigrationError) {
            res.status(err.status).json({ error: err.message });
            return;
        }
        next(err);
    });
    return router;
}
