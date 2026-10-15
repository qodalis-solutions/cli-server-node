import { badRequest } from '../errors';

const PERMISSION_RE = /^(\*|[a-z0-9_.-]+(:([a-z0-9_.-]+|\*))*)$/i;
export const MAX_PERMISSION_LENGTH = 128;
export const MAX_PERMISSIONS_PER_GROUP = 100;

/** 400 unless every entry is a valid permission string (and the list is not too long). */
export function validatePermissions(values: string[]): string[] {
    if (values.length > MAX_PERMISSIONS_PER_GROUP) {
        throw badRequest(`a group may have at most ${MAX_PERMISSIONS_PER_GROUP} permissions`);
    }
    for (const p of values) {
        if (p.length > MAX_PERMISSION_LENGTH || !PERMISSION_RE.test(p)) {
            // eslint-disable-next-line no-control-regex
            throw badRequest(`invalid permission: ${p.slice(0, MAX_PERMISSION_LENGTH).replace(/[\u0000-\u001f\u007f]/g, '')}`);
        }
    }
    return values;
}
