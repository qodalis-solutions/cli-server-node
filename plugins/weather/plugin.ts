/**
 * The entry point of the weather plugin installed at runtime (`qodalis.entry`): the `weather` commands, with the
 * default place as a setting (`config set weather.settings.defaultLocation Paris`), read on every command.
 */
import type { CliConfigSettingDefinition, CliPluginContext, CliPluginEntryInfo, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { DEFAULT_WEATHER_LOCATION, WeatherModule } from './index';

/** The plugin, for `builder.addPlugin(entry, options)` (the marketplace's record says it for an installed copy). */
export const plugin: CliPluginEntryInfo = { id: 'weather', package: '@qodalis/cli-server-plugin-weather', title: 'Weather', icon: '🌤️' };

/** Its settings (also `qodalis.config` of its package.json; code options of the same keys are their defaults). */
export const settings: CliConfigSettingDefinition[] = [
    {
        key: 'defaultLocation',
        label: 'Default location',
        description: 'The place when a command names none',
        type: 'string',
        default: DEFAULT_WEATHER_LOCATION,
        validation: { required: true, max: 100 },
    },
];

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const provider = await context.settings({
        title: 'Weather',
        description: 'The weather commands (wttr.in)',
        settings,
    });
    return new WeatherModule({ defaultLocation: () => String(provider.value('settings', 'defaultLocation') ?? DEFAULT_WEATHER_LOCATION) });
}
