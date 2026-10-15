import { randomUUID } from 'crypto';
import { User, CreateUserDto, UpdateUserDto } from '../models';
import { ICliUserStore } from './interfaces';

const clone = (u: User): User => ({ ...u, groups: [...u.groups] });

export class InMemoryUserStore implements ICliUserStore {
    private users: Map<string, User> = new Map();

    async getUsers(): Promise<User[]> {
        return Array.from(this.users.values()).map(clone);
    }

    async getUser(idOrName: string): Promise<User | undefined> {
        const byId = this.users.get(idOrName);
        if (byId) {
            return clone(byId);
        }
        const lower = idOrName.toLowerCase();
        for (const user of this.users.values()) {
            if (user.name.toLowerCase() === lower) {
                return clone(user);
            }
        }
        return undefined;
    }

    private assertUnique(name: string | undefined, email: string | undefined, exceptId?: string): void {
        for (const user of this.users.values()) {
            if (user.id === exceptId) continue;
            if (name !== undefined && user.name.toLowerCase() === name.toLowerCase()) {
                throw new Error(`User with name '${name}' already exists`);
            }
            if (email !== undefined && user.email.toLowerCase() === email.toLowerCase()) {
                throw new Error(`User with email '${email}' already exists`);
            }
        }
    }

    async createUser(data: CreateUserDto): Promise<User> {
        this.assertUnique(data.name, data.email);

        const now = Date.now();
        const user: User = {
            id: randomUUID(),
            name: data.name,
            email: data.email,
            groups: [...(data.groups ?? [])],
            disabled: data.disabled ?? false,
            mustChangePassword: data.mustChangePassword ?? false,
            ...(data.homeDir !== undefined ? { homeDir: data.homeDir } : {}),
            ...(data.data !== undefined ? { data: data.data } : {}),
            createdAt: now,
            updatedAt: now,
        };

        this.users.set(user.id, user);
        return clone(user);
    }

    async updateUser(id: string, data: UpdateUserDto): Promise<User> {
        const user = this.users.get(id);
        if (!user) {
            throw new Error(`User with id '${id}' not found`);
        }
        this.assertUnique(data.name, data.email, id);

        const updated: User = {
            ...user,
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.email !== undefined ? { email: data.email } : {}),
            ...(data.groups !== undefined ? { groups: [...data.groups] } : {}),
            ...(data.disabled !== undefined ? { disabled: data.disabled } : {}),
            ...(data.mustChangePassword !== undefined ? { mustChangePassword: data.mustChangePassword } : {}),
            ...(data.homeDir !== undefined ? { homeDir: data.homeDir } : {}),
            ...(data.data !== undefined ? { data: data.data } : {}),
            ...(data.lastLoginAt !== undefined ? { lastLoginAt: data.lastLoginAt } : {}),
            updatedAt: Date.now(),
        };

        this.users.set(id, updated);
        return clone(updated);
    }

    async deleteUser(id: string): Promise<void> {
        this.users.delete(id);
    }
}
