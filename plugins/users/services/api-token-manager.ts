import { ICliUserStore } from '../stores/interfaces';
import { ApiTokenAudience, ApiTokenCreateOptions, ApiTokenView, CliPermission, CreatedApiToken, User } from '../models';
import { AuthService, INVALID_AUDIENCE } from './auth-service';
import { HttpError, badRequest, forbidden, notFound } from '../errors';
import { hasPermission } from '../permissions';

/**
 * A programming error, not an HTTP one: a missing user id must never reach the stores
 * (where `getTokens(undefined)` would list every user's tokens).
 */
function requireUserId(userId: unknown): asserts userId is string {
    if (typeof userId !== 'string' || userId === '') {
        throw new TypeError('userId is required');
    }
}

export type { ApiTokenCreateOptions, CreatedApiToken } from '../models';

/**
 * API tokens a host application creates, lists and revokes for its users
 * (`usersPlugin.apiTokens`), e.g. on its own account pages for users who never sign
 * in to the CLI. Same validation, limits, audit entries and events as the HTTP routes;
 * errors are {@link HttpError}s with the status and text the route would answer.
 * Only this manager creates `host` tokens: they carry `host`-surface catalog entries
 * and are accepted only by the host's guards (`requireAuth` / `requirePermission`).
 */
export class ApiTokenManager {
    constructor(
        private readonly authService: AuthService,
        private readonly userStore: ICliUserStore,
        private readonly flags: { externalAuth: boolean; apiTokensWithExternalAuth: boolean },
    ) {}

    /**
     * Creates a token for the user. A missing or empty `userId` throws a `TypeError` (every
     * method). 501 with an auth adapter unless API tokens are
     * enabled with it; 404 `user not found`; 403 `account disabled`; 400 for a bad
     * audience; then the rules of `POST /tokens`, the `host` rules and the grant check
     * against the user's live permissions.
     */
    async create(userId: string, options: ApiTokenCreateOptions): Promise<CreatedApiToken> {
        requireUserId(userId);
        if (this.flags.externalAuth && !this.flags.apiTokensWithExternalAuth) {
            throw new HttpError(501, 'Authentication is managed by the host application');
        }
        const user = await this.requireUser(userId);
        if (user.disabled) {
            throw forbidden('account disabled');
        }
        const opts = options ?? ({} as ApiTokenCreateOptions);
        const audience = this.audienceOf(opts.audience);
        const grantable = await this.authService.getEffectivePermissions(user);
        const actorName = opts.actor ?? user.name;
        const { token, apiToken } = await this.authService.createApiTokenFor(
            user,
            grantable,
            { ...opts, audience },
            { name: actorName, id: opts.actor === undefined ? user.id : undefined },
        );
        return { token, apiToken: this.authService.toApiTokenView(apiToken, user.name) };
    }

    /**
     * The user's tokens, oldest first, both audiences; empty for an unknown user. Views
     * carry `usage` when a usage provider is registered (`setTokenUsageProvider`).
     */
    async list(userId: string): Promise<ApiTokenView[]> {
        requireUserId(userId);
        const user = await this.findUser(userId);
        if (!user) return [];
        const tokens = await this.authService.listApiTokens(user.id);
        return this.authService.withTokenUsage(tokens.map((t) => this.authService.toApiTokenView(t, user.name)));
    }

    /**
     * Revokes the user's token: false when it does not exist or belongs to another
     * user, true once revoked. Audited with `actor` (default the owner's name).
     */
    async revoke(userId: string, tokenId: string, actor?: string): Promise<boolean> {
        requireUserId(userId);
        const token = await this.authService.apiTokenStore.getToken(tokenId);
        if (!token || token.userId !== userId) return false;
        const ownerName = (await this.findUser(userId))?.name ?? userId;
        await this.authService.revokeApiTokenCore(token, ownerName, {
            name: actor ?? ownerName,
            id: actor === undefined ? userId : undefined,
        });
        return true;
    }

    /**
     * The catalog entries the user may put on a token of this audience: for `cli`
     * every entry they hold, for `host` the `host`-surface entries they hold.
     * 404 for an unknown user, 400 for a bad audience.
     */
    async grantablePermissions(userId: string, audience: ApiTokenAudience = 'cli'): Promise<CliPermission[]> {
        requireUserId(userId);
        const user = await this.requireUser(userId);
        const aud = this.audienceOf(audience);
        const held = await this.authService.getEffectivePermissions(user);
        return this.authService
            .permissionCatalog()
            .all()
            .filter((p) => (aud === 'cli' || p.surface === 'host') && hasPermission(held, p.name));
    }

    /** The user with this id (by id only, never by name). */
    private async findUser(userId: string): Promise<User | undefined> {
        if (typeof userId !== 'string' || !userId) return undefined;
        const user = await this.userStore.getUser(userId);
        return user && user.id === userId ? user : undefined;
    }

    private async requireUser(userId: string): Promise<User> {
        const user = await this.findUser(userId);
        if (!user) throw notFound('user not found');
        return user;
    }

    private audienceOf(value: unknown): ApiTokenAudience {
        if (value === undefined) return 'cli';
        if (value === 'cli' || value === 'host') return value;
        throw badRequest(INVALID_AUDIENCE);
    }
}
