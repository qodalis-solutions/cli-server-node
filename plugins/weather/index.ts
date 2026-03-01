import {
    CliCommandProcessor,
    CliCommandParameterDescriptor,
    CliModule,
    CliProcessCommand,
    ICliCommandProcessor,
    ICliCommandParameterDescriptor,
} from '@qodalis/cli-server-abstractions';

function getLocation(command: CliProcessCommand): string {
    if (command.args?.location) return String(command.args.location);
    if (command.value) return command.value;
    return 'London';
}

async function fetchWeatherData(location: string): Promise<any> {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'qodalis-cli/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
}

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
);

class WeatherCurrentProcessor extends CliCommandProcessor {
    command = 'current';
    description = 'Shows current weather conditions';
    parameters = [locationParam];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatCurrentWeather(getLocation(command));
    }
}

class WeatherForecastProcessor extends CliCommandProcessor {
    command = 'forecast';
    description = 'Shows a 3-day weather forecast';
    parameters = [locationParam];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatForecast(getLocation(command));
    }
}

class CliWeatherCommandProcessor extends CliCommandProcessor {
    command = 'weather';
    description = 'Shows weather information for a location';
    parameters = [locationParam];
    processors: ICliCommandProcessor[] = [
        new WeatherCurrentProcessor(),
        new WeatherForecastProcessor(),
    ];

    async handleAsync(command: CliProcessCommand): Promise<string> {
        return formatCurrentWeather(getLocation(command));
    }
}

export class WeatherModule extends CliModule {
    name = 'weather';
    version = '1.0.0';
    description = 'Provides weather information commands';
    processors: ICliCommandProcessor[] = [new CliWeatherCommandProcessor()];
}
