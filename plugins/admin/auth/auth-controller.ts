import { Router, Request, Response } from 'express';
import { signToken } from './jwt-service';
import { AuthenticatedRequest, createAuthMiddleware } from './auth-middleware';
import { AdminConfig } from '../services/admin-config';

/** Tracks consecutive failed login attempts from a single IP. */
interface FailedAttempt {
    count: number;
    firstAttemptAt: number;
}

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
 * - POST /login — authenticate and receive JWT
 * - GET  /me    — get current user info from token
 */
export function createAuthController(config: AdminConfig, jwtSecret: string): AuthControllerResult {
    const router = Router();
    const authMiddleware = createAuthMiddleware(jwtSecret);
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

    router.post('/login', (req: Request, res: Response): void => {
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

        if (!username || !password) {
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        if (!config.validateCredentials(username, password)) {
            // Track failed attempt
            const existing = failedAttempts.get(ip);
            if (existing && now - existing.firstAttemptAt <= WINDOW_MS) {
                existing.count++;
            } else {
                failedAttempts.set(ip, { count: 1, firstAttemptAt: now });
            }

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
