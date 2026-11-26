/**
 * The entry point of the portal plugin (`qodalis.entry`, `builder.addPlugin`): the developer portal site at `path`,
 * showing the guides of the docs plugin and the API reference of the public-api plugin, however they were added
 * (code, mount or marketplace: the `portal.section.docs` and `portal.section.api` services). It loads after them
 * (`CLI_PLUGIN_LOAD_ORDER.DEFAULT + 10`); without either it is `needs-configuration`. The path, name and logo are its
 * settings (provider `portal-plugin`); branding and colours stay the `portal` provider's.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { CliPortalBuilder, DEFAULT_PORTAL_NAME, DEFAULT_PORTAL_PATH } from './cli-portal-builder';
import type { PortalSection } from './portal-options';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'portal', package: '@qodalis/cli-server-plugin-portal', title: 'Portal', icon: '🏠' };

/** After the docs and public-api plugins it shows (`CLI_PLUGIN_LOAD_ORDER.DEFAULT + 10`). */
export const order = 60;

/** The id of its settings provider (`portal` is the provider of its branding). */
export const SETTINGS_ID = 'portal-plugin';

/** Its settings (code options of the same keys are their defaults; `theme`, `footerLinks`, `sections` and `siteDir` from code only). */
export const settings: CliConfigSettingDefinition[] = [
    { key: 'path', label: 'Path', description: 'Where the portal is served (/ for the root)', type: 'string', default: DEFAULT_PORTAL_PATH, requiresRestart: true, validation: { required: true, pattern: '^(/|(/[A-Za-z0-9._~-]+)+)$' } },
    { key: 'name', label: 'Name', type: 'string', default: DEFAULT_PORTAL_NAME, requiresRestart: true, validation: { required: true, max: 80 } },
    { key: 'logoUrl', label: 'Logo', description: 'An http(s) URL or a root-relative path; empty: none', type: 'string', default: '', requiresRestart: true, validation: { max: 2000 } },
];

type SectionSource = { portalSection: PortalSection; pages?: readonly unknown[] };

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({ id: SETTINGS_ID, title: 'Portal (setup)', description: 'Where the developer portal is served', settings });
    const text = (key: string) => String(provider.value('settings', key) ?? '').trim();
    const sections = (context.options.sections as SectionSource[] | undefined) ?? (['docs', 'api'].map((kind) => context.services.get<SectionSource>(`portal.section.${kind}`)).filter(Boolean) as SectionSource[]);
    if (sections.length === 0) return context.needsConfiguration('a docs or public-api plugin (install one, or add it before the portal)');
    const builder = new CliPortalBuilder().setPath(text('path') || DEFAULT_PORTAL_PATH).setName(text('name') || DEFAULT_PORTAL_NAME);
    if (text('logoUrl')) builder.setLogoUrl(text('logoUrl'));
    if (typeof context.options.siteDir === 'string') builder.setSiteDir(context.options.siteDir);
    const theme = context.options.theme;
    if (theme && typeof theme === 'object') builder.setTheme(theme as Parameters<CliPortalBuilder['setTheme']>[0]);
    for (const link of (context.options.footerLinks as Array<{ label: string; url: string }> | undefined) ?? []) builder.addFooterLink(link);
    for (const section of sections) builder.addSection(section);
    return builder.build();
}
