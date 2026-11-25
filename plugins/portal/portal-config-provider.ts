import { CliStoredConfigProvider } from '@qodalis/cli-server-abstractions';
import { MAX_FOOTER_LINKS, validateFooterLinks, validateLogo, validateName, type PortalLink, type PortalThemeMode } from './portal-options';

/** The portal's branding that `config set portal.branding.<key>` changes (the theme colours stay in code). */
export interface PortalBranding {
    name: string;
    /** `null`: no logo. */
    logo: string | null;
    themeMode: PortalThemeMode;
    footerLinks: PortalLink[];
}

/** What the read-only `site` section shows. */
export interface PortalSiteFacts {
    /** The mount (`/qcli/portal`). */
    path: string;
    siteFound: boolean;
    /** The sections added (`docs`, `api`), in the order added. */
    sections: string[];
}

const message = (check: () => unknown): string | undefined => {
    try {
        check();
        return undefined;
    } catch (err) {
        return (err as Error).message;
    }
};

/** The rule of a new `footerLinks` value: a list of at most 20 `{ label, url }` links, as `addFooterLink` checks them. */
export function footerLinksError(value: unknown): string | undefined {
    if (!Array.isArray(value)) return 'must be a list of { "label": ..., "url": ... } links';
    if (value.length > MAX_FOOTER_LINKS) return `must have at most ${MAX_FOOTER_LINKS} links`;
    if (value.some((link) => link === null || typeof link !== 'object' || Array.isArray(link))) {
        return 'must be a list of { "label": ..., "url": ... } links';
    }
    return message(() => validateFooterLinks(value as PortalLink[]));
}

/**
 * `portal`: the branding (`branding`: name, logo, theme mode, footer links), changeable at runtime;
 * the builder's values are the defaults and every change is in the next `/portal.json`. Where the
 * portal is mounted and whether its site was found are read-only (`site`).
 */
export function createPortalConfigProvider(defaults: PortalBranding, current: PortalBranding, site: PortalSiteFacts): CliStoredConfigProvider {
    return new CliStoredConfigProvider({
        id: 'portal',
        title: 'Portal',
        description: 'Branding of the documentation portal (/portal.json)',
        order: 80,
        sections: [
            {
                id: 'branding',
                title: 'Branding',
                description: 'Shown by the portal site; a change is in the next /portal.json, no restart. The theme colours are set in code (setTheme).',
                settings: [
                    {
                        key: 'name',
                        label: 'Name',
                        description: 'The site name, in the header and the page title',
                        type: 'string',
                        default: defaults.name,
                        validation: { min: 1, max: 80 },
                        validate: (value) => message(() => validateName(value)),
                        apply: (value) => (current.name = typeof value === 'string' ? value : defaults.name),
                    },
                    {
                        key: 'logoUrl',
                        label: 'Logo',
                        description: "An http(s) URL, a root-relative path or a base64 data:image URL; '' for none",
                        type: 'string',
                        default: defaults.logo,
                        validation: { max: 200_000 },
                        validate: (value) => (value === '' ? undefined : message(() => validateLogo(value))),
                        apply: (value) => (current.logo = typeof value === 'string' && value !== '' ? value : null),
                    },
                    {
                        key: 'themeMode',
                        label: 'Theme',
                        description: 'The colour scheme the site opens in',
                        type: 'enum',
                        default: defaults.themeMode,
                        validation: { options: ['system', 'light', 'dark'] },
                        apply: (value) => (current.themeMode = (value as PortalThemeMode | null) ?? defaults.themeMode),
                    },
                    {
                        key: 'footerLinks',
                        label: 'Footer links',
                        description: `At most ${MAX_FOOTER_LINKS} links: [{ "label": "Terms", "url": "https://example.com/terms" }], url http(s) or root-relative`,
                        type: 'json',
                        default: defaults.footerLinks.map((l) => ({ ...l })),
                        validate: footerLinksError,
                        apply: (value) =>
                            (current.footerLinks = Array.isArray(value) ? validateFooterLinks(value as PortalLink[]) : defaults.footerLinks.map((l) => ({ ...l }))),
                    },
                ],
            },
            {
                id: 'site',
                title: 'Site',
                description: 'Set in code (setPath, setSiteDir, addSection)',
                settings: [
                    { key: 'path', label: 'Path', description: 'Where the portal is mounted', type: 'string', mutable: false, requiresRestart: true, default: site.path },
                    {
                        key: 'siteFound',
                        label: 'Site found',
                        description: 'Whether the portal site was found (without it nothing is served)',
                        type: 'boolean',
                        mutable: false,
                        requiresRestart: true,
                        default: site.siteFound,
                    },
                    {
                        key: 'sections',
                        label: 'Sections',
                        description: 'The sections published: docs (guides), api (API reference)',
                        type: 'string[]',
                        mutable: false,
                        requiresRestart: true,
                        default: [...site.sections],
                    },
                ],
            },
        ],
    });
}

/** The branding's value as `portal.json` and the command show it. */
export function cloneBranding(branding: PortalBranding): PortalBranding {
    return { ...branding, footerLinks: branding.footerLinks.map((l) => ({ ...l })) };
}
