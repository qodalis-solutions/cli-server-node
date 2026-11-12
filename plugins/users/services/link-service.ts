import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { AuthContext, AuthService } from './auth-service';

import { HttpError, badRequest, notFound } from '../errors';
import { validatePermissions } from './permission-validation';

// Link requests: a terminal (`server add` in the web CLI) asks to be linked and a signed-in
// user approves it in a browser (spec: web-cli
// docs/superpowers/specs/2026-11-12-server-linking-design.md).

/** Seconds a link request waits for its approval. */
export const LINK_EXPIRES_IN_SECONDS = 600;
/** Seconds between two polls of the terminal. */
export const LINK_POLL_INTERVAL_SECONDS = 2;
/** Pending requests kept at most; the oldest is dropped when full. */
export const MAX_PENDING_LINKS = 100;
/** The approval page of the admin dashboard. */
export const DEFAULT_LINK_APPROVAL_URL = '/qcli/admin/link';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_CLIENT_LENGTH = 100;
const TOKEN_NAME_MAX = 64;

type LinkStatus = 'pending' | 'approved' | 'denied';

interface LinkRequest {
    linkId: string;
    /** sha256 of the normalised user code */
    codeHash: Buffer;
    userCode: string;
    client: string;
    permissions?: string[];
    origin?: string;
    remoteAddress?: string;
    createdAt: number;
    expiresAt: number;
    status: LinkStatus;
    token?: string;
    userName?: string;
    tokenExpiresAt?: number | null;
}

/** What `POST /link` returns. */
export interface LinkCreated {
    linkId: string;
    userCode: string;
    verificationUrl: string;
    expiresIn: number;
    interval: number;
}

/** What `GET /link/{linkId}` returns. */
export type LinkPoll =
    | { status: 'pending' | 'denied' }
    | { status: 'approved'; token: string; userName: string; expiresAt: number | null };

/** What the approval page shows. */
export interface LinkView {
    userCode: string;
    client: string;
    origin: string | null;
    remoteAddress: string | null;
    permissions: string[] | null;
    createdAt: number;
    expiresAt: number;
}

/** `ABCD2345` → `ABCD-2345`. */
function formatCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Upper case without dashes and spaces (`abcd-2345` → `ABCD2345`). */
export function normalizeUserCode(code: string): string {
    return code.replace(/[\s-]/g, '').toUpperCase();
}

function hashCode(code: string): Buffer {
    return createHash('sha256').update(normalizeUserCode(code)).digest();
}

/** A token name from a client name: `link <client>`, `[A-Za-z0-9._ -]` only, at most 64 characters. */
export function linkTokenName(client: string, suffix = 0): string {
    const tail = suffix > 0 ? ` ${suffix + 1}` : '';
    const base = `link ${client}`.replace(/[^A-Za-z0-9._ -]/g, '-').trim();
    return base.slice(0, TOKEN_NAME_MAX - tail.length).trimEnd() + tail;
}

/** Where the approval page is: `{code}` replaced, otherwise `?code=` appended. */
export function linkVerificationUrl(approvalUrl: string, userCode: string): string {
    const code = encodeURIComponent(userCode);
    if (approvalUrl.includes('{code}')) return approvalUrl.split('{code}').join(code);
    return `${approvalUrl}${approvalUrl.includes('?') ? '&' : '?'}code=${code}`;
}

/** Link requests in memory: created by terminals, approved or denied by signed-in users. */
export class LinkService {
    private readonly links = new Map<string, LinkRequest>();

    constructor(
        private readonly authService: AuthService,
        private readonly approvalUrl: string = DEFAULT_LINK_APPROVAL_URL,
        private readonly now: () => number = Date.now,
    ) {}

    /** `POST /link`. */
    create(body: Record<string, unknown>, origin?: string, remoteAddress?: string): LinkCreated {
        const client = typeof body.client === 'string' ? body.client.trim() : '';
        if (client.length < 1 || client.length > MAX_CLIENT_LENGTH || /[\u0000-\u001f\u007f]/.test(client)) {
            throw badRequest(`client must be 1-${MAX_CLIENT_LENGTH} characters`);
        }
        let permissions: string[] | undefined;
        if (body.permissions !== undefined && body.permissions !== null) {
            const value = body.permissions;
            if (!Array.isArray(value) || value.length === 0 || value.some((p) => typeof p !== 'string' || p.length === 0)) {
                throw badRequest('permissions must be a non-empty array of strings');
            }
            permissions = validatePermissions(value as string[]);
        }

        this.sweep();
        while (this.links.size >= MAX_PENDING_LINKS) {
            const oldest = this.links.keys().next().value as string;
            this.links.delete(oldest);
        }

        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
        const userCode = formatCode(code);
        const linkId = randomBytes(32).toString('base64url');
        const now = this.now();
        this.links.set(linkId, {
            linkId,
            codeHash: hashCode(code),
            userCode,
            client,
            ...(permissions ? { permissions } : {}),
            ...(origin ? { origin: origin.slice(0, 200) } : {}),
            ...(remoteAddress ? { remoteAddress } : {}),
            createdAt: now,
            expiresAt: now + LINK_EXPIRES_IN_SECONDS * 1000,
            status: 'pending',
        });
        return {
            linkId,
            userCode,
            verificationUrl: linkVerificationUrl(this.approvalUrl, userCode),
            expiresIn: LINK_EXPIRES_IN_SECONDS,
            interval: LINK_POLL_INTERVAL_SECONDS,
        };
    }

    /** `GET /link/{linkId}`: the token is handed out once, then the request is gone. */
    poll(linkId: string): LinkPoll | undefined {
        this.sweep();
        const link = this.links.get(linkId);
        if (!link) return undefined;
        if (link.status === 'approved') {
            this.links.delete(linkId);
            return { status: 'approved', token: link.token!, userName: link.userName!, expiresAt: link.tokenExpiresAt ?? null };
        }
        if (link.status === 'denied') {
            this.links.delete(linkId);
            return { status: 'denied' };
        }
        return { status: 'pending' };
    }

    /** The pending request with this user code (constant-time compare). */
    private findPending(userCode: string): LinkRequest | undefined {
        this.sweep();
        const hash = hashCode(userCode);
        let found: LinkRequest | undefined;
        for (const link of this.links.values()) {
            if (timingSafeEqual(link.codeHash, hash) && link.status === 'pending') found = link;
        }
        return found;
    }

    /** `GET /link/code/{userCode}`. */
    view(userCode: string): LinkView {
        const link = this.findPending(userCode);
        if (!link) throw notFound('link request not found or expired');
        return {
            userCode: link.userCode,
            client: link.client,
            origin: link.origin ?? null,
            remoteAddress: link.remoteAddress ?? null,
            permissions: link.permissions ?? null,
            createdAt: link.createdAt,
            expiresAt: link.expiresAt,
        };
    }

    /** `POST /link/code/{userCode}/approve`: creates the approver's API token for the terminal. */
    async approve(ctx: AuthContext, userCode: string): Promise<{ tokenId: string; tokenName: string }> {
        const link = this.findPending(userCode);
        if (!link) throw notFound('link request not found or expired');
        let created: Awaited<ReturnType<AuthService['createApiToken']>> | undefined;
        for (let suffix = 0; !created; suffix++) {
            try {
                created = await this.authService.createApiToken(ctx, {
                    name: linkTokenName(link.client, suffix),
                    ...(link.permissions ? { permissions: link.permissions } : {}),
                });
            } catch (err) {
                if (!(err instanceof HttpError && err.status === 409) || suffix >= 20) throw err;
            }
        }
        // Approved while the request was waiting: it may have been approved twice in parallel
        if (link.status !== 'pending' || !this.links.has(link.linkId)) {
            throw notFound('link request not found or expired');
        }
        link.status = 'approved';
        link.token = created.token;
        link.userName = ctx.user.name;
        link.tokenExpiresAt = created.apiToken.expiresAt;
        await this.authService.audit({
            event: 'link_approved',
            username: ctx.user.name,
            userId: ctx.user.id,
            actor: ctx.user.name,
            actorId: ctx.user.id,
            details: `${link.client} (${created.apiToken.name})`,
            metadata: { client: link.client, ...(link.origin ? { origin: link.origin } : {}), tokenId: created.apiToken.id },
        });
        return { tokenId: created.apiToken.id, tokenName: created.apiToken.name };
    }

    /** `POST /link/code/{userCode}/deny`. */
    async deny(ctx: AuthContext, userCode: string): Promise<void> {
        const link = this.findPending(userCode);
        if (!link) throw notFound('link request not found or expired');
        link.status = 'denied';
        await this.authService.audit({
            event: 'link_denied',
            username: ctx.user.name,
            userId: ctx.user.id,
            actor: ctx.user.name,
            actorId: ctx.user.id,
            details: link.client,
            metadata: { client: link.client, ...(link.origin ? { origin: link.origin } : {}) },
        });
    }

    /** Drops expired requests (an approved token not collected in time is revoked by nobody: it stays listed). */
    sweep(): void {
        const now = this.now();
        for (const [id, link] of this.links) {
            if (link.expiresAt <= now) this.links.delete(id);
        }
    }
}
