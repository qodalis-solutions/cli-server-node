import { Router, Request, Response, NextFunction, json } from 'express';
import { CliMigrationError, type CliMigrationRunOptions } from './runner';
import type { CliMigrations } from './migrations';

/** Permissions of the migrations API (declared as route permissions; a protected server enforces them). */
export const MigrationsPermissions = {
    Read: 'migrations:read',
    Run: 'migrations:run',
} as const;

function callerName(req: Request): string | undefined {
    return (req as Request & { qcliServerAuth?: { userName?: string } }).qcliServerAuth?.userName;
}

/**
 * `GET /` databases, `GET /:db` migrations, `GET /:db/runs`, `GET /:db/sql` (dry run), `POST /:db/up`,
 * `POST /:db/down`. Errors answer `{ error }`: 404 unknown database or migration, 409 busy or blocked.
 */
export function createMigrationsController(migrations: CliMigrations): Router {
    const router = Router();
    router.use(json({ limit: '16kb' }));
    const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
    const runner = (req: Request) => {
        const db = migrations.database(req.params.db);
        if (!db) throw new CliMigrationError(`unknown database: ${req.params.db}`, 404);
        return db;
    };
    const text = (value: unknown, name: string): string | undefined => {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' || value.length > 200) throw new CliMigrationError(`${name} must be a migration id`, 400);
        return value;
    };

    router.get('/', wrap(async (_req, res) => {
        res.json({ databases: await migrations.overview() });
    }));

    router.get('/:db', wrap(async (req, res) => {
        const db = runner(req);
        res.json({ name: db.name, dialect: db.dialect, sources: db.sourceNames, migrations: await db.status() });
    }));

    router.get('/:db/runs', wrap(async (req, res) => {
        const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
        const page = Math.max(1, Number(req.query.page) || 1);
        res.json(await runner(req).runs(size, (page - 1) * size));
    }));

    router.get('/:db/sql', wrap(async (req, res) => {
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
            res.json(await migrations.run(req.params.db, direction, options));
        });
    router.post('/:db/up', run('up'));
    router.post('/:db/down', run('down'));

    router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (err instanceof CliMigrationError) {
            res.status(err.status).json({ error: err.message });
            return;
        }
        next(err);
    });
    return router;
}
