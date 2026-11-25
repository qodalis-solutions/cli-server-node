import {
    CliCommandParameterDescriptor,
    CliCommandProcessor,
    CliConfigPermissions,
    CliProcessCommand,
    ICliCommandProcessor,
} from '@qodalis/cli-server-abstractions';
import type { PortalLink, PortalThemeColors, PortalThemeMode } from './portal-options';
import { PORTAL_SITE_SOURCES, type PortalSiteSource } from './site-dir';

/** What `portal --json` prints: `portal.json` (docs with its page count) and where the site is. */
export interface PortalStatus {
    name: string;
    logo: string | null;
    theme: { mode: PortalThemeMode; dark: PortalThemeColors; light: PortalThemeColors };
    footerLinks: PortalLink[];
    docs: { title: string; pages: string; pageCount: number | null } | null;
    api: { title: string; openapi: string; swagger: string } | null;
    site: { path: string; found: boolean; source: PortalSiteSource | null; dir: string | null };
}

const jsonParam = new CliCommandParameterDescriptor('json', 'Print the status as JSON (portal.json and the site)', false, 'boolean');

export const PORTAL_BRANDING_HINT = 'Change the branding with config set portal.branding.<key> <value> (name, logoUrl, themeMode, footerLinks).';

/** The status as text: the mount, the site, the sections and the branding. */
export function formatPortalStatus(status: PortalStatus): string {
    const lines = [`Portal: ${status.site.path}`];
    if (status.site.found && status.site.source) {
        lines.push(`Site: found, ${PORTAL_SITE_SOURCES[status.site.source]} (${status.site.dir})`);
    } else {
        lines.push('Site: not found, the portal is not served (install @qodalis/cli-server-portal or call setSiteDir)');
    }
    if (!status.docs && !status.api) {
        lines.push('Sections: none (the site shows "Nothing published yet")');
    } else {
        lines.push('Sections:');
        if (status.docs) {
            const count = status.docs.pageCount === null ? '' : `, ${status.docs.pageCount} ${status.docs.pageCount === 1 ? 'page' : 'pages'}`;
            lines.push(`  docs  ${status.docs.title}${count} (${status.docs.pages})`);
        }
        if (status.api) lines.push(`  api   ${status.api.title} (${status.api.openapi})`);
    }
    const links = status.footerLinks.length ? status.footerLinks.map((l) => `${l.label} (${l.url})`).join(', ') : '(none)';
    const logo = status.logo === null ? '(none)' : status.logo.startsWith('data:') ? `${status.logo.slice(0, status.logo.indexOf(',') + 1)}… (${status.logo.length} characters)` : status.logo;
    lines.push(
        'Branding:',
        `  name         ${status.name}`,
        `  logoUrl      ${logo}`,
        `  themeMode    ${status.theme.mode}`,
        `  footerLinks  ${links}`,
        '',
        PORTAL_BRANDING_HINT,
    );
    return lines.join('\n');
}

class PortalStatusProcessor extends CliCommandProcessor {
    command = 'status';
    description = 'The portal: its path, the site, the sections and the branding';
    parameters = [jsonParam];
    examples = [
        { command: 'portal status', description: 'The portal at a glance' },
        { command: 'portal status --json', description: 'portal.json and the site as JSON' },
    ];

    constructor(private readonly status: () => PortalStatus) {
        super();
    }

    async handleAsync(command: CliProcessCommand): Promise<string> {
        const status = this.status();
        return command.args?.json ? JSON.stringify(status, null, 2) : formatPortalStatus(status);
    }
}

/**
 * `portal` (= `portal status`) `[--json]`: needs `config:read` (it shows the portal's settings, as
 * `config get portal` does); the portal itself stays public. Branding is changed with `config set`.
 */
export class CliPortalCommandProcessor extends CliCommandProcessor {
    command = 'portal';
    description = `Documentation portal: path, site, sections and branding. ${PORTAL_BRANDING_HINT}`;
    module = 'portal';
    icon = '🌐';
    requiredPermissions = [CliConfigPermissions.Read];
    parameters = [jsonParam];
    examples = [
        { command: 'portal', description: 'The portal at a glance' },
        { command: 'portal --json', description: 'portal.json and the site as JSON' },
        { command: 'config set portal.branding.name "RateBell API"', description: 'Rename the site (no restart)' },
        { command: 'config set portal.branding.themeMode dark', description: 'Open the site in the dark theme' },
    ];
    processors: ICliCommandProcessor[];
    private readonly statusProcessor: PortalStatusProcessor;

    constructor(status: () => PortalStatus) {
        super();
        this.statusProcessor = new PortalStatusProcessor(status);
        this.processors = [this.statusProcessor];
    }

    handleAsync(command: CliProcessCommand): Promise<string> {
        return this.statusProcessor.handleAsync(command);
    }
}
