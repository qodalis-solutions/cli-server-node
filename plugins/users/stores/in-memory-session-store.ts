import { randomUUID } from 'crypto';
import { Session, SessionMetadata } from '../models';
import { ICliSessionStore } from './interfaces';

export class InMemorySessionStore implements ICliSessionStore {
    /** Keyed by token hash (SHA-256 hex); raw tokens are never stored. */
    private sessions: Map<string, Session> = new Map();

    async createSession(userId: string, tokenHash: string, metadata: SessionMetadata): Promise<Session> {
        const now = Date.now();
        const session: Session = {
            id: randomUUID(),
            tokenHash,
            userId,
            createdAt: now,
            lastActivity: now,
            metadata: { ...metadata },
        };
        this.sessions.set(tokenHash, session);
        return { ...session };
    }

    async getSession(tokenHash: string): Promise<Session | undefined> {
        const s = this.sessions.get(tokenHash);
        return s ? { ...s } : undefined;
    }

    async getSessionById(id: string): Promise<Session | undefined> {
        for (const session of this.sessions.values()) {
            if (session.id === id) {
                return { ...session };
            }
        }
        return undefined;
    }

    async getActiveSessions(): Promise<Session[]> {
        return Array.from(this.sessions.values()).map((s) => ({ ...s }));
    }

    async deleteSession(tokenHash: string): Promise<void> {
        this.sessions.delete(tokenHash);
    }

    async deleteSessionById(id: string): Promise<void> {
        for (const [token, session] of this.sessions.entries()) {
            if (session.id === id) {
                this.sessions.delete(token);
                return;
            }
        }
    }

    async deleteUserSessions(userId: string): Promise<void> {
        for (const [token, session] of this.sessions.entries()) {
            if (session.userId === userId) {
                this.sessions.delete(token);
            }
        }
    }

    async updateLastActivity(tokenHash: string): Promise<void> {
        const session = this.sessions.get(tokenHash);
        if (session) {
            session.lastActivity = Date.now();
        }
    }

    async cleanup(maxAgeMs: number): Promise<void> {
        const cutoff = Date.now() - maxAgeMs;
        for (const [token, session] of this.sessions.entries()) {
            if (session.lastActivity < cutoff) {
                this.sessions.delete(token);
            }
        }
    }
}
