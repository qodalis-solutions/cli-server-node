import { Router, Request, Response } from 'express';
import { DirectoryService, bodyOf, callerOf } from '../services/directory-service';
import { toUserJson } from '../services/auth-service';
import { can, getAuth, requirePermission } from '../middleware/auth-middleware';
import { asyncHandler, forbidden } from '../errors';
import { UsersPermissions as P, inGroup } from '../permissions';

/** `/groups` resource. Expects the auth middleware to have run. */
export function createGroupsController(directory: DirectoryService): Router {
    const router = Router();

    // GET / — any authenticated user
    router.get('/', asyncHandler(async (_req: Request, res: Response) => {
        res.json(await directory.listGroups());
    }));

    // POST / — groups:create
    router.post('/', requirePermission(P.GroupsCreate), asyncHandler(async (req: Request, res: Response) => {
        const group = await directory.createGroup(bodyOf(req), callerOf(getAuth(req)));
        res.status(201).json(group);
    }));

    // GET /:name — any authenticated user
    router.get('/:name', asyncHandler(async (req: Request, res: Response) => {
        res.json(await directory.getGroupOr404(req.params.name));
    }));

    // PUT /:name — groups:update
    router.put('/:name', requirePermission(P.GroupsUpdate), asyncHandler(async (req: Request, res: Response) => {
        const body = bodyOf(req);
        const group = await directory.getGroupOr404(req.params.name);
        res.json(await directory.updateGroup(group, body, callerOf(getAuth(req))));
    }));

    // DELETE /:name — groups:delete
    router.delete('/:name', requirePermission(P.GroupsDelete), asyncHandler(async (req: Request, res: Response) => {
        const group = await directory.getGroupOr404(req.params.name);
        await directory.deleteGroup(group, callerOf(getAuth(req)));
        res.status(204).end();
    }));

    // GET /:name/members — groups:read or member
    router.get('/:name/members', asyncHandler(async (req: Request, res: Response) => {
        const auth = getAuth(req);
        const privileged = can(req, P.GroupsRead);
        const group = await directory.getGroupOr404(req.params.name);
        if (!privileged && !inGroup(auth.user.groups, group.name)) {
            throw forbidden(`forbidden: missing permission ${P.GroupsRead}`);
        }
        res.json((await directory.getMembers(group)).map(toUserJson));
    }));

    // POST /:name/members/:idOrName — groups:update (PUT kept as a legacy alias)
    const addMember = asyncHandler(async (req: Request, res: Response) => {
        await directory.addMember(req.params.name, req.params.idOrName, callerOf(getAuth(req)));
        res.status(204).end();
    });
    router.post('/:name/members/:idOrName', requirePermission(P.GroupsUpdate), addMember);
    router.put('/:name/members/:idOrName', requirePermission(P.GroupsUpdate), addMember);

    // DELETE /:name/members/:idOrName — groups:update
    router.delete('/:name/members/:idOrName', requirePermission(P.GroupsUpdate), asyncHandler(async (req: Request, res: Response) => {
        const group = await directory.getGroupOr404(req.params.name);
        const user = await directory.getUserOr404(req.params.idOrName);
        await directory.removeMember(group, user, callerOf(getAuth(req)));
        res.status(204).end();
    }));

    return router;
}
