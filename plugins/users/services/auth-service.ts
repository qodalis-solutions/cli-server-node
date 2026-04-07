import { createHash, randomBytes } from 'crypto';
import { ICliUserStore, ICliSessionStore, ICliCredentialStore, ICliAuditStore } from '../stores/interfaces';
import { Session, SessionMetadata } from '../models';

export class AuthService {
    constructor(
        private readonly userStore: ICliUserStore,
        private readonly sessionStore: ICliSessionStore,
        private readonly credentialStore: ICliCredentialStore,
        private readonly auditStore: ICliAuditStore,
    ) {}

    generateToken(): string {
        return randomBytes(32).toString('hex');
    }

    private hashPassword(password: string, salt: string): string {
        return createHash('sha256').update(salt + password).digest('hex');
    }

    async setPassword(userId: string, password: string): Promise<void> {
        const salt = randomBytes(16).toString('hex');
        const hash = this.hashPassword(password, salt);
        await this.credentialStore.setPassword(userId, hash, salt);
    }

    async verifyPassword(userId: string, password: string): Promise<boolean> {
        const creds = await this.credentialStore.getCredentials(userId);
        if (!creds) {
            return false;
        }
        const hash = this.hashPassword(password, creds.salt);
        return hash === creds.passwordHash;
    }

    async login(
        username: string,
        password: string,
        metadata: SessionMetadata = {},
    ): Promise<{ token: string; session: Session }> {
        const user = await this.userStore.getUser(username);
        if (!user) {
            await this.auditStore.log({
                timestamp: Date.now(),
                event: 'login_failed',
                username,
                details: 'User not found',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw new Error('Invalid credentials');
        }

        if (user.disabled) {
            await this.auditStore.log({
                timestamp: Date.now(),
                event: 'login_failed',
                username,
                details: 'Account disabled',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw new Error('Account is disabled');
        }

        const valid = await this.verifyPassword(user.id, password);
        if (!valid) {
            await this.auditStore.log({
                timestamp: Date.now(),
                event: 'login_failed',
                username,
                details: 'Wrong password',
                metadata: { remoteAddress: metadata.remoteAddress },
            });
            throw new Error('Invalid credentials');
        }

        // Update lastLoginAt by storing it in the user data field
        const freshUser = { ...user, lastLoginAt: Date.now() };

        const token = this.generateToken();
        const session = await this.sessionStore.createSession(user.id, token, freshUser, metadata);

        await this.auditStore.log({
            timestamp: Date.now(),
            event: 'login',
            username,
            details: 'Login successful',
            metadata: {
                remoteAddress: metadata.remoteAddress,
                sessionId: session.id,
            },
        });

        return { token, session };
    }

    async logout(token: string): Promise<void> {
        const session = await this.sessionStore.getSession(token);
        const username = session?.user?.name ?? 'unknown';

        await this.sessionStore.deleteSession(token);

        await this.auditStore.log({
            timestamp: Date.now(),
            event: 'logout',
            username,
            details: 'User logged out',
            metadata: {
                sessionId: session?.id,
            },
        });
    }
}
