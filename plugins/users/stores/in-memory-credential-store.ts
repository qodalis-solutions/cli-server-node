import { Credentials } from '../models';
import { ICliCredentialStore } from './interfaces';

export class InMemoryCredentialStore implements ICliCredentialStore {
    private credentials: Map<string, Credentials> = new Map();

    async setPassword(userId: string, hash: string, salt: string): Promise<void> {
        this.credentials.set(userId, {
            userId,
            passwordHash: hash,
            salt,
            lastChanged: Date.now(),
        });
    }

    async getCredentials(userId: string): Promise<Credentials | undefined> {
        return this.credentials.get(userId);
    }

    async deleteCredentials(userId: string): Promise<void> {
        this.credentials.delete(userId);
    }
}
