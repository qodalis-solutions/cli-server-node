import { ICliUserStore, ICliGroupStore } from '../stores/interfaces';
import { Group, User, UpdateUserDto } from '../models';
import { AuthService } from './auth-service';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { ADMIN_GROUP, BUILT_IN_GROUPS, USERS_GROUP, inGroup, mergePermissions, sameName } from '../permissions';
import { hasControlChars, uncoveredPermissions } from '../security';

// ------------------------------------------------------------- validation

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
// Email: dot-atom local part (max 64) @ DNS labels ending in a letters-only TLD, or localhost; same rule as web-cli and the other servers.
export const EMAIL_RE = /^(?=[^@]{1,64}@)[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:localhost|(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})$/;
const PERMISSION_RE = /^(\*|[a-z0-9_.-]+(:([a-z0-9_.-]+|\*))*)$/i;
export const MAX_NAME_LENGTH = 64;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_PERMISSION_LENGTH = 128;
export const MAX_PERMISSIONS_PER_GROUP = 100;
export const MAX_DESCRIPTION_LENGTH = 256;
export const MAX_DATA_BYTES = 16 * 1024;
export const MAX_HOME_DIR_LENGTH = 1024;

/** The caller of a management operation. */
export interface Caller {
    id: string;
    name: string;
    permissions: string[];
}

function validateName(value: string, field: string): string {
    if (value.length < 1 || value.length > MAX_NAME_LENGTH || !NAME_RE.test(value)) {
        throw badRequest(`${field} must be 1-${MAX_NAME_LENGTH} characters of [A-Za-z0-9._@-], starting with a letter or digit`);
    }
    return value;
}

function validateEmail(value: string): string {
    if (value.length > MAX_EMAIL_LENGTH || hasControlChars(value) || !EMAIL_RE.test(value)) {
        throw badRequest('email must be a valid address (name@example.com, at most 254 characters)');
    }
    return value;
}

function validateFreeText(value: string, field: string, max: number): string {
    if (value.length > max) throw badRequest(`${field} must be at most ${max} characters`);
    if (hasControlChars(value)) throw badRequest(`${field} must not contain control characters`);
    return value;
}

function validatePermissions(values: string[]): string[] {
    if (values.length > MAX_PERMISSIONS_PER_GROUP) {
        throw badRequest(`a group may have at most ${MAX_PERMISSIONS_PER_GROUP} permissions`);
    }
    for (const p of values) {
        if (p.length > MAX_PERMISSION_LENGTH || !PERMISSION_RE.test(p)) {
            throw badRequest(`invalid permission: ${p.slice(0, MAX_PERMISSION_LENGTH).replace(/[\u0000-\u001f\u007f]/g, '')}`);
        }
    }
    return values;
}

function validateData(value: Record<string, any>): Record<string, any> {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DATA_BYTES) {
        throw badRequest('data must be at most 16 KB when serialized');
    }
    return value;
}

function stringField(body: Record<string, unknown>, field: string, required: boolean): string | undefined {
    const value = body[field];
    if (value === undefined || value === null) {
        if (required) throw badRequest(`${field} is required`);
        return undefined;
    }
    if (typeof value !== 'string' || (required && value.length === 0)) {
        throw badRequest(required ? `${field} is required` : `${field} must be a string`);
    }
    return value;
}

export function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
    const value = body[field];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
        throw badRequest(`${field} must be an array of strings`);
    }
    return value as string[];
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
 * privilege-escalation rules, cascades and audit events.
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

    /** Resolves group names to stored groups; unknown → 400 `unknown group: x`. */
    async resolveGroups(names: string[]): Promise<Group[]> {
        const out: Group[] = [];
        for (const name of names) {
            const group = await this.groupStore.getGroup(name);
            if (!group) throw badRequest(`unknown group: ${name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_NAME_LENGTH)}`);
            if (!out.some((g) => sameName(g.name, group.name))) out.push(group);
        }
        return out;
    }

    /** Name and email share one uniqueness namespace (409). */
    private async assertUniqueUser(name: string | undefined, email: string | undefined, exceptId?: string): Promise<void> {
        const users = await this.userStore.getUsers();
        for (const u of users) {
            if (u.id === exceptId) continue;
            if (name !== undefined && (sameName(u.name, name) || sameName(u.email, name))) {
                throw conflict(`user '${name}' already exists`);
            }
            if (email !== undefined && (sameName(u.email, email) || sameName(u.name, email))) {
                throw conflict(`email '${email}' is already in use`);
            }
        }
    }

    /** True when `user` is the only enabled member of `admin`. */
    async isLastEnabledAdmin(user: User): Promise<boolean> {
        if (user.disabled || !inGroup(user.groups, ADMIN_GROUP)) return false;
        const users = await this.userStore.getUsers();
        return !users.some((u) => u.id !== user.id && !u.disabled && inGroup(u.groups, ADMIN_GROUP));
    }

    // ------------------------------------------------- privilege escalation

    /** 403 unless every permission is covered by the caller's permissions. */
    assertCanGrant(caller: Caller, permissions: readonly string[]): void {
        const missing = uncoveredPermissions(caller.permissions, permissions);
        if (missing.length > 0) {
            throw forbidden(`cannot grant permissions you do not hold: ${mergePermissions(missing).join(', ')}`);
        }
    }

    /** 403 unless the caller covers every permission of every group being added. */
    assertCanAddGroups(caller: Caller, groups: readonly Group[]): void {
        this.assertCanGrant(caller, mergePermissions(...groups.map((g) => g.permissions ?? [])));
    }

    /** 403 unless the caller covers the target's effective permissions (self is always allowed). */
    async assertCanActOn(caller: Caller, target: User): Promise<void> {
        if (caller.id === target.id) return;
        const targetPermissions = await this.authService.getEffectivePermissions(target);
        if (uncoveredPermissions(caller.permissions, targetPermissions).length > 0) {
            throw forbidden('insufficient privileges for this user');
        }
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

    async createUser(body: Record<string, unknown>, caller: Caller, externalAuth = false): Promise<User> {
        const name = validateName(stringField(body, 'name', true)!, 'name');
        const email = validateEmail(stringField(body, 'email', true)!);
        const groupsIn = optionalStringArray(body, 'groups');
        const disabled = optionalBoolean(body, 'disabled');
        const homeDirIn = stringField(body, 'homeDir', false);
        const homeDir = homeDirIn !== undefined ? validateFreeText(homeDirIn, 'homeDir', MAX_HOME_DIR_LENGTH) : undefined;
        const dataIn = optionalObject(body, 'data');
        const data = dataIn !== undefined ? validateData(dataIn) : undefined;
        const password = body.password;
        if (password !== undefined && password !== null) {
            if (externalAuth) {
                throw badRequest('passwords are managed by the host application');
            }
            this.authService.validatePassword(password);
        }

        const explicitGroups = groupsIn && groupsIn.length > 0;
        const groups = await this.resolveGroups(explicitGroups ? groupsIn! : [USERS_GROUP]);
        if (explicitGroups) {
            this.assertCanAddGroups(caller, groups);
        }
        await this.assertUniqueUser(name, email);

        const user = await this.userStore.createUser({
            name,
            email,
            groups: groups.map((g) => g.name),
            disabled: disabled ?? false,
            mustChangePassword: false,
            homeDir,
            data,
        });
        if (typeof password === 'string') {
            await this.authService.setPassword(user.id, password);
        }
        await this.authService.audit({ event: 'user_created', username: user.name, userId: user.id, actor: caller.name, actorId: caller.id });
        return user;
    }

    async updateUser(target: User, body: Record<string, unknown>, caller: Caller): Promise<User> {
        const nameIn = stringField(body, 'name', false);
        const name = nameIn !== undefined ? validateName(nameIn, 'name') : undefined;
        const emailIn = stringField(body, 'email', false);
        const email = emailIn !== undefined ? validateEmail(emailIn) : undefined;
        const groupsIn = optionalStringArray(body, 'groups');
        const disabled = optionalBoolean(body, 'disabled');
        const homeDirIn = stringField(body, 'homeDir', false);
        const homeDir = homeDirIn !== undefined ? validateFreeText(homeDirIn, 'homeDir', MAX_HOME_DIR_LENGTH) : undefined;
        const dataIn = optionalObject(body, 'data');
        const data = dataIn !== undefined ? validateData(dataIn) : undefined;

        const groups = groupsIn !== undefined ? await this.resolveGroups(groupsIn) : undefined;

        if (name !== undefined || groups !== undefined || disabled !== undefined) {
            await this.assertCanActOn(caller, target);
        }
        if (groups !== undefined) {
            this.assertCanAddGroups(caller, groups.filter((g) => !inGroup(target.groups, g.name)));
        }
        await this.assertUniqueUser(name, email, target.id);

        const groupNames = groups?.map((g) => g.name);
        const lastAdmin = await this.isLastEnabledAdmin(target);
        if (lastAdmin && disabled === true) {
            throw conflict('cannot disable the last enabled member of admin');
        }
        if (lastAdmin && groupNames !== undefined && !inGroup(groupNames, ADMIN_GROUP)) {
            throw conflict('cannot remove the last enabled member of admin from admin');
        }

        const dto: UpdateUserDto = {};
        if (name !== undefined) dto.name = name;
        if (email !== undefined) dto.email = email;
        if (groupNames !== undefined) dto.groups = groupNames;
        if (disabled !== undefined) dto.disabled = disabled;
        if (homeDir !== undefined) dto.homeDir = homeDir;
        if (data !== undefined) dto.data = data;

        const updated = await this.userStore.updateUser(target.id, dto);
        const audit = { username: updated.name, userId: updated.id, actor: caller.name, actorId: caller.id };
        const disabledChanged = disabled !== undefined && disabled !== !!target.disabled;

        // Revoke before any audit: audits make open sockets re-check their session, and
        // that re-check must not end these sessions before they are kicked.
        if (disabledChanged && disabled) {
            await this.authService.revokeUserSessions(target.id, 'user disabled', {
                actor: caller.name,
                actorId: caller.id,
                userName: updated.name,
            });
        }
        const otherFields = ['name', 'email', 'groups', 'homeDir', 'data'].filter((f) => (dto as any)[f] !== undefined);
        if (otherFields.length > 0) {
            await this.authService.audit({ event: 'user_updated', ...audit, details: otherFields.join(', ') });
        }
        if (disabledChanged) {
            await this.authService.audit({ event: disabled ? 'user_disabled' : 'user_enabled', ...audit });
        }
        return updated;
    }

    async deleteUser(target: User, caller: Caller): Promise<void> {
        if (target.id === caller.id) {
            throw conflict('cannot delete yourself');
        }
        await this.assertCanActOn(caller, target);
        if (await this.isLastEnabledAdmin(target)) {
            throw conflict('cannot delete the last enabled member of admin');
        }
        await this.userStore.deleteUser(target.id);
        await this.authService.deleteCredentials(target.id);
        await this.authService.revokeUserSessions(target.id, 'user deleted', {
            actor: caller.name,
            actorId: caller.id,
            userName: target.name,
        });
        await this.authService.audit({ event: 'user_deleted', username: target.name, userId: target.id, actor: caller.name, actorId: caller.id });
    }

    async setMustChangePassword(user: User, value: boolean): Promise<void> {
        if (!!user.mustChangePassword !== value) {
            await this.userStore.updateUser(user.id, { mustChangePassword: value });
        }
    }

    // --------------------------------------------------------------- groups

    async listGroups(): Promise<Group[]> {
        return this.groupStore.getGroups();
    }

    async createGroup(body: Record<string, unknown>, caller: Caller): Promise<Group> {
        const name = validateName(stringField(body, 'name', true)!, 'name');
        const descriptionIn = stringField(body, 'description', false);
        const description = descriptionIn !== undefined ? validateFreeText(descriptionIn, 'description', MAX_DESCRIPTION_LENGTH) : undefined;
        const permissions = validatePermissions(optionalStringArray(body, 'permissions') ?? []);
        this.assertCanGrant(caller, permissions);
        if (await this.groupStore.getGroup(name)) {
            throw conflict(`group '${name}' already exists`);
        }
        const group = await this.groupStore.createGroup({ name, description, permissions, builtIn: false });
        await this.authService.audit({ event: 'group_created', username: caller.name, userId: caller.id, actor: caller.name, actorId: caller.id, details: group.name });
        return group;
    }

    async updateGroup(group: Group, body: Record<string, unknown>, caller: Caller): Promise<Group> {
        const descriptionIn = stringField(body, 'description', false);
        const description = descriptionIn !== undefined ? validateFreeText(descriptionIn, 'description', MAX_DESCRIPTION_LENGTH) : undefined;
        const permissionsIn = optionalStringArray(body, 'permissions');
        const permissions = permissionsIn !== undefined ? validatePermissions(permissionsIn) : undefined;
        if (permissions !== undefined && sameName(group.name, ADMIN_GROUP)) {
            throw conflict('admin group permissions cannot be changed');
        }
        if (permissions !== undefined) {
            this.assertCanGrant(caller, permissions);
        }
        const updated = await this.groupStore.updateGroup(group.name, { description, permissions });
        await this.authService.audit({ event: 'group_updated', username: caller.name, userId: caller.id, actor: caller.name, actorId: caller.id, details: group.name });
        return updated;
    }

    async deleteGroup(group: Group, caller: Caller): Promise<void> {
        if (group.builtIn || BUILT_IN_GROUPS.some((g) => sameName(g, group.name))) {
            throw conflict(`built-in group '${group.name}' cannot be deleted`);
        }
        await this.groupStore.deleteGroup(group.name);
        for (const user of await this.userStore.getUsers()) {
            if (inGroup(user.groups, group.name)) {
                await this.userStore.updateUser(user.id, { groups: user.groups.filter((g) => !sameName(g, group.name)) });
            }
        }
        await this.authService.audit({ event: 'group_deleted', username: caller.name, userId: caller.id, actor: caller.name, actorId: caller.id, details: group.name });
    }

    async getMembers(group: Group): Promise<User[]> {
        return (await this.userStore.getUsers()).filter((u) => inGroup(u.groups, group.name));
    }

    /** Adds a member; unknown group → 400 `unknown group: x`, unknown user → 404. */
    async addMember(groupName: string, userIdOrName: string, caller: Caller): Promise<void> {
        const [group] = await this.resolveGroups([groupName]);
        const user = await this.getUserOr404(userIdOrName);
        if (inGroup(user.groups, group.name)) return;
        await this.assertCanActOn(caller, user);
        this.assertCanAddGroups(caller, [group]);
        await this.userStore.updateUser(user.id, { groups: [...user.groups, group.name] });
        await this.authService.audit({ event: 'group_member_added', username: user.name, userId: user.id, actor: caller.name, actorId: caller.id, details: group.name });
    }

    async removeMember(group: Group, user: User, caller: Caller): Promise<void> {
        if (!inGroup(user.groups, group.name)) return;
        await this.assertCanActOn(caller, user);
        if (sameName(group.name, ADMIN_GROUP) && (await this.isLastEnabledAdmin(user))) {
            throw conflict('cannot remove the last enabled member of admin from admin');
        }
        await this.userStore.updateUser(user.id, { groups: user.groups.filter((g) => !sameName(g, group.name)) });
        await this.authService.audit({ event: 'group_member_removed', username: user.name, userId: user.id, actor: caller.name, actorId: caller.id, details: group.name });
    }
}

export function callerOf(ctx: { user: User; permissions: string[] }): Caller {
    return { id: ctx.user.id, name: ctx.user.name, permissions: ctx.permissions };
}
