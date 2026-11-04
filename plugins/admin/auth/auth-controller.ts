import { Router, Request, Response } from 'express';
import { signToken } from './jwt-service';
import { AuthenticatedRequest, createAuthMiddleware } from './auth-middleware';
import { AdminConfig } from '../services/admin-config';
import { AdminAuthProvider, ADMIN_ACCESS_PERMISSION, errorMessage, errorStatus } from './auth-provider';

/** Tracks consecutive failed login attempts from a single IP. */
interface FailedAttempt {
    count: number;
    firstAttemptAt: number;
}

/** Mode name for the dashboard's own username/password form. */
export const ADMIN_AUTH_MODE_PASSWORD = 'password';
/** Mode name for sign-in through the host application. */
export const ADMIN_AUTH_MODE_EXTERNAL = 'external';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000; // 1 minute

/** Return value of {@link createAuthController}. */
export interface AuthControllerResult {
    /** Express router with login and user-info routes. */
    router: Router;
    /** Interval handle for cleaning up expired rate-limit entries; clear on shutdown. */
    cleanupInterval: ReturnType<typeof setInterval>;
}

/**
 * Creates the auth controller router.
 *
 * Routes (relative to mount point):
 * - GET  /mode  — public: `{ mode: 'password' | 'external', signInUrl }`
 * - POST /login — authenticate and receive JWT (501 in external mode)
 * - GET  /me    — get current user info from token
 */
export function createAuthController(
    config: AdminConfig,
    jwtSecret: string,
    provider?: AdminAuthProvider,
    isExternal: () => boolean = () => false,
): AuthControllerResult {
    const router = Router();
    const authMiddleware = createAuthMiddleware(jwtSecret, provider, isExternal);
    const failedAttempts = new Map<string, FailedAttempt>();

    // Periodically clean up expired entries (every 5 minutes)
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [ip, attempt] of failedAttempts) {
            if (now - attempt.firstAttemptAt > WINDOW_MS) {
                failedAttempts.delete(ip);
            }
        }
    }, 5 * 60_000);

    // Prevent the timer from keeping the process alive
    if (cleanupInterval.unref) {
        cleanupInterval.unref();
    }

    // GET /mode — public: which sign-in the dashboard shows. `external` when the users
    // plugin uses an external auth adapter (the host app signs users in and hands its
    // token to the dashboard through /qcli/admin/#token=…), otherwise `password`.
    router.get('/mode', (_req: Request, res: Response): void => {
        res.set('Cache-Control', 'no-store');
        res.json({ mode: isExternal() ? ADMIN_AUTH_MODE_EXTERNAL : ADMIN_AUTH_MODE_PASSWORD, signInUrl: config.signInUrl ?? null });
    });

    router.post('/login', (req: Request, res: Response): void => {
        // External sign-in mode: the static admin credentials sign no one in.
        if (isExternal()) {
            const where = config.signInUrl !== undefined ? ` at ${config.signInUrl}` : ' through the host application';
            res.status(501).json({
                error: `Sign-in is managed by the host application. Sign in${where}.`,
                code: 'EXTERNAL_AUTH',
                signInUrl: config.signInUrl ?? null,
            });
            return;
        }
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

        // Rate limiting
        const now = Date.now();
        const attempt = failedAttempts.get(ip);
        if (attempt) {
            if (now - attempt.firstAttemptAt > WINDOW_MS) {
                // Window expired, reset
                failedAttempts.delete(ip);
            } else if (attempt.count >= MAX_ATTEMPTS) {
                res.status(429).json({
                    error: 'Too many failed login attempts. Try again later.',
                });
                return;
            }
        }

        const { username, password } = req.body ?? {};

        if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const recordFailure = () => {
            const existing = failedAttempts.get(ip);
            if (existing && now - existing.firstAttemptAt <= WINDOW_MS) {
                existing.count++;
            } else {
                failedAttempts.set(ip, { count: 1, firstAttemptAt: now });
            }
        };

        if (provider) {
            // Users plugin installed: authenticate through it and require admin:access
            provider
                .login(username, password, { remoteAddress: ip, userAgent: req.headers['user-agent'] })
                .then(async (result) => {
                    if (!provider.hasPermission(result, ADMIN_ACCESS_PERMISSION)) {
                        await provider.logout?.(result.token).catch(() => undefined);
                        res.status(403).json({ error: `forbidden: missing permission ${ADMIN_ACCESS_PERMISSION}` });
                        return;
                    }
                    failedAttempts.delete(ip);
                    res.json({
                        token: result.token,
                        expiresIn: Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000)),
                        username: result.userName,
                        mustChangePassword: !!result.mustChangePassword,
                    });
                })
                .catch((err) => {
                    const status = errorStatus(err);
                    if (status === 401) recordFailure();
                    res.status(status).json({ error: errorMessage(err, 'Invalid credentials') });
                });
            return;
        }

        if (!config.validateCredentials(username, password)) {
            // Track failed attempt
            recordFailure();

            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }

        // Clear failed attempts on success
        failedAttempts.delete(ip);

        const authenticatedAt = new Date().toISOString();
        const token = signToken(
            { username, authenticatedAt },
            jwtSecret,
            '24h',
        );

        res.json({
            token,
            expiresIn: 86400,
            username,
        });
    });

    router.get('/me', authMiddleware, (req: Request, res: Response): void => {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }

        res.json({
            username: authReq.user.username,
            authenticatedAt: authReq.user.authenticatedAt,
        });
    });

    return { router, cleanupInterval };
}
