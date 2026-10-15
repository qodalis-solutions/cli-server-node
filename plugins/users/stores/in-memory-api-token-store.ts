import { ApiToken } from '../models';
import { ICliApiTokenStore } from './interfaces';

function copy(token: ApiToken): ApiToken {
    return { ...token, ...(token.permissions ? { permissions: [...token.permissions] } : {}) };
}

export class InMemoryApiTokenStore implements ICliApiTokenStore {
    /** Keyed by token id. */
    private tokens: Map<string, ApiToken> = new Map();

    async createToken(token: ApiToken): Promise<ApiToken> {
        this.tokens.set(token.id, copy(token));
        return copy(token);
    }

    async getTokenByHash(tokenHash: string): Promise<ApiToken | undefined> {
        for (const token of this.tokens.values()) {
            if (token.tokenHash === tokenHash) {
                return copy(token);
            }
        }
        return undefined;
    }

    async getToken(id: string): Promise<ApiToken | undefined> {
        const token = this.tokens.get(id);
        return token ? copy(token) : undefined;
    }

    async getTokens(userId?: string): Promise<ApiToken[]> {
        return Array.from(this.tokens.values())
            .filter((t) => userId === undefined || t.userId === userId)
            .map(copy);
    }

    async deleteToken(id: string): Promise<void> {
        this.tokens.delete(id);
    }

    async deleteUserTokens(userId: string): Promise<void> {
        for (const [id, token] of this.tokens.entries()) {
            if (token.userId === userId) {
                this.tokens.delete(id);
            }
        }
    }

    async updateLastUsed(id: string, lastUsedAt: number): Promise<void> {
        const token = this.tokens.get(id);
        if (token) {
            token.lastUsedAt = lastUsedAt;
        }
    }
}
