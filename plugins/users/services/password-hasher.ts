import { pbkdf2, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

const pbkdf2Async = promisify(pbkdf2);

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DIGEST = 'sha256';

export interface EncodedPassword {
    /** `pbkdf2$<iterations>$<saltB64>$<hashB64>` */
    hash: string;
    /** Salt, base64 */
    salt: string;
}

/** Hashes a password with PBKDF2-HMAC-SHA256 (100k iterations, 16-byte salt, 32-byte key). */
export async function hashPassword(password: string): Promise<EncodedPassword> {
    const salt = randomBytes(SALT_BYTES);
    const key = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, DIGEST);
    const saltB64 = salt.toString('base64');
    return {
        hash: `pbkdf2$${PBKDF2_ITERATIONS}$${saltB64}$${key.toString('base64')}`,
        salt: saltB64,
    };
}

/**
 * Verifies a password against an encoded hash using a constant-time comparison.
 * Also accepts the legacy format (hex `sha256(salt + password)` with a separate salt).
 */
export async function verifyPasswordHash(password: string, encoded: string, legacySalt?: string): Promise<boolean> {
    if (encoded.startsWith('pbkdf2$')) {
        const parts = encoded.split('$');
        if (parts.length !== 4) {
            return false;
        }
        const iterations = parseInt(parts[1], 10);
        if (!Number.isFinite(iterations) || iterations <= 0) {
            return false;
        }
        const salt = Buffer.from(parts[2], 'base64');
        const expected = Buffer.from(parts[3], 'base64');
        if (expected.length === 0) {
            return false;
        }
        const actual = await pbkdf2Async(password, salt, iterations, expected.length, DIGEST);
        return timingSafeEqual(actual, expected);
    }

    // Legacy: sha256(salt + password) as hex
    if (legacySalt === undefined) {
        return false;
    }
    const actual = createHash('sha256').update(legacySalt + password).digest();
    const expected = Buffer.from(encoded, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
}
