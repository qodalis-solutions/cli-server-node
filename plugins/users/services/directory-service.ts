import { ICliUserStore, ICliGroupStore } from '../stores/interfaces';
import { Group, User, UpdateUserDto } from '../models';
import { AuthService } from './auth-service';
import { badRequest, conflict, notFound } from '../errors';
import { ADMIN_GROUP, BUILT_IN_GROUPS, USERS_GROUP, inGroup, sameName } from '../permissions';

// ------------------------------------------------------------- validation

export function requireString(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw badRequest(`${field} is required`);
    }
    return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, allowEmpty = false): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
        throw badRequest(`${field} must be a non-empty string`);
    }
    return allowEmpty ? value : value.trim();
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
        throw badRequest(`${field} must be an array of strings`);
    }
    return (value as string[]).map((v) => v.trim());
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
        throw badRequest(`${field} must be a boolean`);
    }
    return value;
}

export function optionalObject(body: Record<string, unknown>, field: string): Record<string, any> | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw badRequest(`${field} must be an object`);
    }
    return value as Record<string, any>;
}

export function bodyOf(req: { body?: unknown }): Record<string, unknown> {
    const body = req.body;
    if (body === undefined || body === null || body === '') return {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        throw badRequest('request body must be a JSON object');
    }
    return body as Record<string, unknown>;
}

/**
 * User and group management with the contract's validations, protections,
 * cascades and audit events.
 */
export class DirectoryService {
    constructor(
        private readonly userStore: ICliUserStore,
        private readonly groupStore: ICliGroupStore,
        private readonly authService: AuthService,
    ) {}

    // -------------------------------------------------------------- lookups

    async getUserOr404(idOrName: string): Promise<User> {
        const user = await this.userStore.getUser(idOrName);
        if (!user) throw notFound('user not found');
        return user;
    }

    async getGroupOr404(name: string): Promise<Group> {
        const group = await this.groupStore.getGroup(name);
        if (!group) throw notFound('group not found');
        return group;
    }

    /** Resolves group names to their stored names; unknown → 400 `unknown group: x`. */
    async resolveGroups(names: string[]): Promise<string[]> {
        const out: string[] = [];
        for (const name of names) {
            const group = await this.groupStore.getGroup(name);
            if (!group) throw badRequest(`unknown group: ${name}`);
            if (!inGroup(out, group.name)) out.push(group.name);
        }
        return out;
    }

    private async assertUniqueUser(name: string | undefined, email: string | undefined, exceptId?: string): Promise<void> {
        const users = await this.userStore.getUsers();
        for (const u of users) {
            if (u.id === exceptId) continue;
            if (name !== undefined && sameName(u.name, name)) throw conflict(`user '${name}' already exists`);
            if (email !== undefined && sameName(u.email, email)) throw conflict(`email '${email}' is already in use`);
        }
    }

    /** True when `user` is the only enabled member of `admin`. */
    async isLastEnabledAdmin(user: User): Promise<boolean> {
        if (user.disabled || !inGroup(user.groups, ADMIN_GROUP)) return false;
        const users = await this.userStore.getUsers();
        return !users.some((u) => u.id !== user.id && !u.disabled && inGroup(u.groups, ADMIN_GROUP));
    }

    // ---------------------------------------------------------------- users

    async listUsers(query?: string, skip = 0, take?: number): Promise<User[]> {
        let users = await this.userStore.getUsers();
        if (query) {
            const q = query.toLowerCase();
            users = users.filter((u) => u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q));
        }
        users.sort((a, b) => a.createdAt - b.createdAt);
        return users.slice(skip, take === undefined ? undefined : skip + take);
    }

    async createUser(body: Record<string, unknown>, actor?: string, externalAuth = false): Promise<User> {
        const name = requireString(body, 'name');
        const email = requireString(body, 'email');
        const groupsIn = optionalStringArray(body, 'groups');
        const disabled = optionalBoolean(body, 'disabled');
        const homeDir = optionalString(body, 'homeDir', true);
        const data = optionalObject(body, 'data');
        const password = body.password;
        if (password !== undefined && password !== null) {
            if (externalAuth) {
                throw badRequest('passwords are managed by the host application');
            }
            this.authService.validatePassword(password);
        }

        const groups = await this.resolveGroups(groupsIn && groupsIn.length > 0 ? groupsIn : [USERS_GROUP]);
        await this.assertUniqueUser(name, email);

        const user = await this.userStore.createUser({ name, email, groups, disabled: disabled ?? false, homeDir, data });
        if (typeof password === 'string') {
            await this.authService.setPassword(user.id, password);
        }
        await this.authService.audit({ event: 'user_created', username: user.name, actor });
        return user;
    }

    async updateUser(target: User, body: Record<string, unknown>, actor?: string): Promise<User> {
        const name = optionalString(body, 'name');
        const email = optionalString(body, 'email');
        const groupsIn = optionalStringArray(body, 'groups');
        const disabled = optionalBoolean(body, 'disabled');
        const homeDir = optionalString(body, 'homeDir', true);
        const data = optionalObject(body, 'data');

        const groups = groupsIn !== undefined ? await this.resolveGroups(groupsIn) : undefined;
        await this.assertUniqueUser(name, email, target.id);

        const lastAdmin = await this.isLastEnabledAdmin(target);
        if (lastAdmin && disabled === true) {
            throw conflict('cannot disable the last enabled member of admin');
        }
        if (lastAdmin && groups !== undefined && !inGroup(groups, ADMIN_GROUP)) {
            throw conflict('cannot remove the last enabled member of admin from admin');
        }

        const dto: UpdateUserDto = {};
        if (name !== undefined) dto.name = name;
        if (email !== undefined) dto.email = email;
        if (groups !== undefined) dto.groups = groups;
        if (disabled !== undefined) dto.disabled = disabled;
        if (homeDir !== undefined) dto.homeDir = homeDir;
        if (data !== undefined) dto.data = data;

        const updated = await this.userStore.updateUser(target.id, dto);

        const otherFields = ['name', 'email', 'groups', 'homeDir', 'data'].some((f) => (dto as any)[f] !== undefined);
        if (otherFields) {
            await this.authService.audit({
                event: 'user_updated',
                username: updated.name,
                actor,
                details: Object.keys(dto).filter((k) => k !== 'disabled').join(', '),
            });
        }
        if (disabled !== undefined && disabled !== !!target.disabled) {
            await this.authService.audit({ event: disabled ? 'user_disabled' : 'user_enabled', username: updated.name, actor });
            if (disabled) {
                await this.authService.revokeUserSessions(target.id, 'user disabled', { actor, userName: updated.name });
            }
        }
        return updated;
    }

    async deleteUser(target: User, callerId: string, actor?: string): Promise<void> {
        if (target.id === callerId) {
            throw conflict('cannot delete yourself');
        }
        if (await this.isLastEnabledAdmin(target)) {
            throw conflict('cannot delete the last enabled member of admin');
        }
        await this.userStore.deleteUser(target.id);
        await this.authService.deleteCredentials(target.id);
        await this.authService.revokeUserSessions(target.id, 'user deleted', { actor, userName: target.name });
        await this.authService.audit({ event: 'user_deleted', username: target.name, actor });
    }

    // --------------------------------------------------------------- groups

    async listGroups(): Promise<Group[]> {
        return this.groupStore.getGroups();
    }

    async createGroup(body: Record<string, unknown>, actor?: string): Promise<Group> {
        const name = requireString(body, 'name');
        const description = optionalString(body, 'description', true);
        const permissions = optionalStringArray(body, 'permissions') ?? [];
        if (await this.groupStore.getGroup(name)) {
            throw conflict(`group '${name}' already exists`);
        }
        const group = await this.groupStore.createGroup({ name, description, permissions, builtIn: false });
        await this.authService.audit({ event: 'group_created', username: actor ?? '', actor, details: group.name });
        return group;
    }

    async updateGroup(group: Group, body: Record<string, unknown>, actor?: string): Promise<Group> {
        const description = optionalString(body, 'description', true);
        const permissions = optionalStringArray(body, 'permissions');
        if (permissions !== undefined && sameName(group.name, ADMIN_GROUP)) {
            throw conflict('admin group permissions cannot be changed');
        }
        const updated = await this.groupStore.updateGroup(group.name, { description, permissions });
        await this.authService.audit({ event: 'group_updated', username: actor ?? '', actor, details: group.name });
        return updated;
    }

    async deleteGroup(group: Group, actor?: string): Promise<void> {
        if (group.builtIn || BUILT_IN_GROUPS.some((g) => sameName(g, group.name))) {
            throw conflict(`built-in group '${group.name}' cannot be deleted`);
        }
        await this.groupStore.deleteGroup(group.name);
        for (const user of await this.userStore.getUsers()) {
            if (inGroup(user.groups, group.name)) {
                await this.userStore.updateUser(user.id, { groups: user.groups.filter((g) => !sameName(g, group.name)) });
            }
        }
        await this.authService.audit({ event: 'group_deleted', username: actor ?? '', actor, details: group.name });
    }

    async getMembers(group: Group): Promise<User[]> {
        return (await this.userStore.getUsers()).filter((u) => inGroup(u.groups, group.name));
    }

    /** Adds a member; unknown group → 400 `unknown group: x`, unknown user → 404. */
    async addMember(groupName: string, userIdOrName: string, actor?: string): Promise<void> {
        const group = await this.groupStore.getGroup(groupName);
        if (!group) throw badRequest(`unknown group: ${groupName}`);
        const user = await this.getUserOr404(userIdOrName);
        if (inGroup(user.groups, group.name)) return;
        await this.userStore.updateUser(user.id, { groups: [...user.groups, group.name] });
        await this.authService.audit({ event: 'group_member_added', username: user.name, actor, details: group.name });
    }

    async removeMember(group: Group, user: User, actor?: string): Promise<void> {
        if (!inGroup(user.groups, group.name)) return;
        if (sameName(group.name, ADMIN_GROUP) && (await this.isLastEnabledAdmin(user))) {
            throw conflict('cannot remove the last enabled member of admin from admin');
        }
        await this.userStore.updateUser(user.id, { groups: user.groups.filter((g) => !sameName(g, group.name)) });
        await this.authService.audit({ event: 'group_member_removed', username: user.name, actor, details: group.name });
    }
}
