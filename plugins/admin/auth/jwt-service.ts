import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

export interface JwtPayload {
    username: string;
    authenticatedAt: string;
    [key: string]: unknown;
}

let _defaultSecret: string | undefined;

/**
 * Get the JWT secret, reading from env or generating a random one.
 */
function getDefaultSecret(): string {
    if (!_defaultSecret) {
        _defaultSecret =
            process.env.QCLI_ADMIN_JWT_SECRET ??
            crypto.randomBytes(32).toString('hex');
    }
    return _defaultSecret;
}

/**
 * Sign a JWT token.
 */
export function signToken(
    payload: JwtPayload,
    secret?: string,
    expiresIn: string | number = '24h',
): string {
    const options: jwt.SignOptions = {
        expiresIn: typeof expiresIn === 'number' ? expiresIn : (expiresIn as jwt.SignOptions['expiresIn']),
    };
    return jwt.sign(payload, secret ?? getDefaultSecret(), options);
}

/**
 * Verify and decode a JWT token.
 * Returns the decoded payload, or throws on invalid/expired tokens.
 */
export function verifyToken(
    token: string,
    secret?: string,
): JwtPayload {
    return jwt.verify(token, secret ?? getDefaultSecret()) as JwtPayload;
}

/**
 * Override the default secret (used by CliAdminBuilder).
 */
export function setDefaultSecret(secret: string): void {
    _defaultSecret = secret;
}
