/**
 * The entry point of the weather plugin installed at runtime (`qodalis.entry`): the `weather` commands, with the
 * default place as a setting (`config set weather.settings.defaultLocation Paris`), read on every command.
 */
import type { CliPluginContext, CliPluginEntryResult } from '@qodalis/cli-server-abstractions';
import { DEFAULT_WEATHER_LOCATION, WeatherModule } from './index';

export async function createPlugin(context: CliPluginContext): Promise<CliPluginEntryResult> {
    const settings = await context.settings({
        title: 'Weather',
        description: 'The weather commands (wttr.in)',
        settings: [
            {
                key: 'defaultLocation',
                label: 'Default location',
                description: 'The place when a command names none',
                type: 'string',
                default: DEFAULT_WEATHER_LOCATION,
                validation: { required: true, max: 100 },
            },
        ],
    });
    return new WeatherModule({ defaultLocation: () => String(settings.value('settings', 'defaultLocation') ?? DEFAULT_WEATHER_LOCATION) });
}
