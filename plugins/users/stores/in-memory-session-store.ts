import { randomUUID } from 'crypto';
import { Session, SessionMetadata } from '../models';
import { ICliSessionStore } from './interfaces';

export class InMemorySessionStore implements ICliSessionStore {
    /** Keyed by token. */
    private sessions: Map<string, Session> = new Map();

    async createSession(userId: string, token: string, metadata: SessionMetadata): Promise<Session> {
        const now = Date.now();
        const session: Session = {
            id: randomUUID(),
            token,
            userId,
            createdAt: now,
            lastActivity: now,
            metadata: { ...metadata },
        };
        this.sessions.set(token, session);
        return { ...session };
    }

    async getSession(token: string): Promise<Session | undefined> {
        const s = this.sessions.get(token);
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

    async deleteSession(token: string): Promise<void> {
        this.sessions.delete(token);
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

    async updateLastActivity(token: string): Promise<void> {
        const session = this.sessions.get(token);
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
