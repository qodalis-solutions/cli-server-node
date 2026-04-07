import { randomUUID } from 'crypto';
import { Group } from '../models';
import { ICliGroupStore } from './interfaces';

export class InMemoryGroupStore implements ICliGroupStore {
    private groups: Map<string, Group> = new Map();

    async getGroups(): Promise<Group[]> {
        return Array.from(this.groups.values());
    }

    async getGroup(name: string): Promise<Group | undefined> {
        return this.groups.get(name);
    }

    async createGroup(name: string, description?: string): Promise<Group> {
        if (this.groups.has(name)) {
            throw new Error(`Group '${name}' already exists`);
        }

        const group: Group = {
            id: randomUUID(),
            name,
            description,
            createdAt: Date.now(),
        };

        this.groups.set(name, group);
        return group;
    }

    async deleteGroup(name: string): Promise<void> {
        this.groups.delete(name);
    }
}
