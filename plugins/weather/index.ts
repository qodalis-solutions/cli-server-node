import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliModule,
    CliProcessCommand,
    getPositionalText,
    ICliCommandProcessor,
    ICliCommandParameterDescriptor,
} from '@qodalis/cli-server-abstractions';
import { CLI_INSTALLED_PLUGIN } from '@qodalis/cli-server-abstractions';
import { weatherInstalledPlugin } from './package-info';

/** Extract the location from a command's args or value, defaulting to 'London'. */
function getLocation(command: CliProcessCommand): string {
    if (command.args?.location) return String(command.args.location);
    const location = getPositionalText(command);
    if (location) return location;
    return 'London';
}

/** Fetch raw weather JSON from wttr.in for the given location. */
async function fetchWeatherData(location: string): Promise<any> {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'qodalis-cli/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}

/** Format current weather conditions as a human-readable multi-line string. */
async function formatCurrentWeather(location: string): Promise<string> {
    try {
        const data = await fetchWeatherData(location);
        const current = data.current_condition[0];
        const area = data.nearest_area[0];
        const city = area.areaName[0].value;
        const country = area.country[0].value;

        return [
            `Weather for ${city}, ${country}`,
            `  Condition:   ${current.weatherDesc[0].value}`,
            `  Temperature: ${current.temp_C}°C (feels like ${current.FeelsLikeC}°C)`,
            `  Humidity:    ${current.humidity}%`,
            `  Wind:        ${current.windspeedKmph} km/h ${current.winddir16Point}`,
            `  Visibility:  ${current.visibility} km`,
            `  Pressure:    ${current.pressure} hPa`,
        ].join('\n');
    } catch (err: any) {
        return `Failed to fetch weather data: ${err.message}`;
    }
}

/** Format a 3-day weather forecast as a human-readable multi-line string. */
async function formatForecast(location: string): Promise<string> {
    try {
        const data = await fetchWeatherData(location);
        const area = data.nearest_area[0];
        const city = area.areaName[0].value;
        const country = area.country[0].value;

        const lines = [`3-day forecast for ${city}, ${country}\n`];

        for (const day of data.weather) {
            const desc = day.hourly[4].weatherDesc[0].value;
            const rain = day.hourly[4].chanceofrain;
            lines.push(
                `  ${day.date}: ${desc}, ${day.mintempC}°C - ${day.maxtempC}°C, rain ${rain}%`,
            );
        }

        return lines.join('\n');
    } catch (err: any) {
        return `Failed to fetch forecast data: ${err.message}`;
    }
}

const locationParam: ICliCommandParameterDescriptor = new CliCommandParameterDescriptor(
    'location',
    'Location to get weather for (city name)',
    false,
    'string',
    ['-l'],
    'London',
    undefined,
    ['Paris', 'New York'],
);

/** Processor for the `weather current` sub-command. */
class WeatherCurrentProcessor extends CliCommandProcessor {
    command = 'current';
    description = 'Shows current weather conditions';
    examples = [
        { command: 'weather current Berlin', description: 'Current weather in Berlin' },
    ];
    parameters = [locationParam];
    acceptsValue = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatCurrentWeather(getLocation(command));
    }
}

/** Processor for the `weather forecast` sub-command. */
class WeatherForecastProcessor extends CliCommandProcessor {
    command = 'forecast';
    description = 'Shows a 3-day weather forecast';
    aliases = ['fc'];
    examples = [
        { command: 'weather forecast Tokyo', description: 'Three-day forecast for Tokyo' },
    ];
    parameters = [locationParam];
    acceptsValue = true;

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatForecast(getLocation(command));
    }
}

/** Root processor for the `weather` command, delegating to current/forecast sub-commands. */
class CliWeatherCommandProcessor extends CliCommandProcessor {
    command = 'weather';
    description = 'Shows weather information for a location';
    module = 'weather';
    icon = '🌤';
    examples = [
        { command: 'weather London', description: 'Current weather in London' },
        { command: 'weather forecast --location Paris', description: 'Three-day forecast for Paris' },
    ];
    documentation =
        'Weather from wttr.in, fetched by the server. Give the place as the value or with --location; the default is London.';
    parameters = [locationParam];
    acceptsValue = true;
    processors: ICliCommandProcessor[] = [
        new WeatherCurrentProcessor(),
        new WeatherForecastProcessor(),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatCurrentWeather(getLocation(command));
    }
}

/** CLI module providing weather information commands (current conditions and forecast). */
export class WeatherModule extends CliModule {
    /** The package this class belongs to, listed among the server's installed plugins. */
    static readonly [CLI_INSTALLED_PLUGIN] = weatherInstalledPlugin;

    name = 'weather';
    version = '1.0.0';
    description = 'Provides weather information commands';
    processors: ICliCommandProcessor[] = [new CliWeatherCommandProcessor()];
}
