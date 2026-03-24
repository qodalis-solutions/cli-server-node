import * as jwt from 'jsonwebtoken';

/** JWT token payload containing user identity and authentication timestamp. */
export interface JwtPayload {
    username: string;
    authenticatedAt: string;
    [key: string]: unknown;
}

/**
 * Sign a JWT token with the given payload and secret.
 *
 * @param payload - Claims to include in the token.
 * @param secret - HMAC secret used for signing.
 * @param expiresIn - Token lifetime (e.g. '24h' or seconds).
 * @returns The signed JWT string.
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
 *
 * @param token - The JWT string to verify.
 * @param secret - HMAC secret used during signing.
 * @returns The decoded payload.
 * @throws If the token is invalid or expired.
 */
export function verifyToken(
    token: string,
    secret: string,
): JwtPayload {
    return jwt.verify(token, secret) as JwtPayload;
}
