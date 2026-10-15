import { randomUUID } from 'crypto';
import { Group, CreateGroupDto, UpdateGroupDto } from '../models';
import { ICliGroupStore } from './interfaces';

const clone = (g: Group): Group => ({ ...g, permissions: [...g.permissions] });

export class InMemoryGroupStore implements ICliGroupStore {
    /** Keyed by lower-cased name; the name itself is stored as given. */
    private groups: Map<string, Group> = new Map();

    async getGroups(): Promise<Group[]> {
        return Array.from(this.groups.values()).map(clone);
    }

    async getGroup(name: string): Promise<Group | undefined> {
        const g = this.groups.get(name.toLowerCase());
        return g ? clone(g) : undefined;
    }

    async createGroup(data: CreateGroupDto): Promise<Group> {
        const key = data.name.toLowerCase();
        if (this.groups.has(key)) {
            throw new Error(`Group '${data.name}' already exists`);
        }

        const now = Date.now();
        const group: Group = {
            id: randomUUID(),
            name: data.name,
            ...(data.description !== undefined ? { description: data.description } : {}),
            permissions: [...(data.permissions ?? [])],
            builtIn: data.builtIn ?? false,
            createdAt: now,
            updatedAt: now,
        };

        this.groups.set(key, group);
        return clone(group);
    }

    async updateGroup(name: string, data: UpdateGroupDto): Promise<Group> {
        const key = name.toLowerCase();
        const group = this.groups.get(key);
        if (!group) {
            throw new Error(`Group '${name}' not found`);
        }
        const updated: Group = {
            ...group,
            ...(data.description !== undefined ? { description: data.description } : {}),
            ...(data.permissions !== undefined ? { permissions: [...data.permissions] } : {}),
            updatedAt: Date.now(),
        };
        this.groups.set(key, updated);
        return clone(updated);
    }

    async deleteGroup(name: string): Promise<void> {
        this.groups.delete(name.toLowerCase());
    }
}
