import * as jwt from 'jsonwebtoken';

export interface JwtPayload {
    username: string;
    authenticatedAt: string;
    [key: string]: unknown;
}

/**
 * Sign a JWT token.
 */
export function signToken(
    payload: JwtPayload,
    secret: string,
    expiresIn: string | number = '24h',
): string {
    const options: jwt.SignOptions = {
        expiresIn: typeof expiresIn === 'number' ? expiresIn : (expiresIn as jwt.SignOptions['expiresIn']),
    };
    return jwt.sign(payload, secret, options);
}

/**
 * Verify and decode a JWT token.
 * Returns the decoded payload, or throws on invalid/expired tokens.
 */
export function verifyToken(
    token: string,
    secret: string,
): JwtPayload {
    return jwt.verify(token, secret) as JwtPayload;
}
