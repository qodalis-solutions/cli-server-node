import { randomUUID } from 'crypto';
import { User, CreateUserDto, UpdateUserDto } from '../models';
import { ICliUserStore } from './interfaces';

export class InMemoryUserStore implements ICliUserStore {
    private users: Map<string, User> = new Map();

    async getUsers(): Promise<User[]> {
        return Array.from(this.users.values());
    }

    async getUser(idOrName: string): Promise<User | undefined> {
        // Try by id first
        if (this.users.has(idOrName)) {
            return this.users.get(idOrName);
        }
        // Fall back to case-insensitive name lookup
        const lower = idOrName.toLowerCase();
        for (const user of this.users.values()) {
            if (user.name.toLowerCase() === lower) {
                return user;
            }
        }
        return undefined;
    }

    async createUser(data: CreateUserDto): Promise<User> {
        // Check for duplicate name (case-insensitive)
        const lower = data.name.toLowerCase();
        for (const user of this.users.values()) {
            if (user.name.toLowerCase() === lower) {
                throw new Error(`User with name '${data.name}' already exists`);
            }
        }

        const now = Date.now();
        const user: User = {
            id: randomUUID(),
            name: data.name,
            email: data.email,
            groups: data.groups ?? [],
            data: data.data,
            createdAt: now,
            updatedAt: now,
        };

        this.users.set(user.id, user);
        return user;
    }

    async updateUser(id: string, data: UpdateUserDto): Promise<User> {
        const user = this.users.get(id);
        if (!user) {
            throw new Error(`User with id '${id}' not found`);
        }

        const updated: User = {
            ...user,
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.email !== undefined ? { email: data.email } : {}),
            ...(data.groups !== undefined ? { groups: data.groups } : {}),
            ...(data.disabled !== undefined ? { disabled: data.disabled } : {}),
            ...(data.data !== undefined ? { data: data.data } : {}),
            updatedAt: Date.now(),
        };

        this.users.set(id, updated);
        return updated;
    }

    async deleteUser(id: string): Promise<void> {
        this.users.delete(id);
    }
}
