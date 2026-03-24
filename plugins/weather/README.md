# @qodalis/cli-server-plugin-weather

Weather information plugin for [Qodalis CLI Server (Node.js)](https://github.com/qodalis-solutions/cli-server-node). Provides current weather conditions and 3-day forecast commands using the wttr.in API.

## Install

```bash
npm install @qodalis/cli-server-plugin-weather
```

## Quick Start

```typescript
import { createCliServer } from '@qodalis/cli-server-node';
import { WeatherModule } from '@qodalis/cli-server-plugin-weather';

const { app } = createCliServer({
    configure: (builder) => {
        builder.addModule(new WeatherModule());
    },
});
```

## Commands

| Command | Description |
|---------|-------------|
| `weather [location]` | Show current weather conditions (defaults to London) |
| `weather current [location]` | Show current weather conditions |
| `weather forecast [location]` | Show a 3-day weather forecast |

## Parameters

| Parameter | Alias | Type | Default | Description |
|-----------|-------|------|---------|-------------|
| `--location` | `-l` | `string` | `London` | City name to get weather for |

The location can also be passed as the command value (e.g. `weather Paris`).

## Example Output

```
Weather for Paris, France
  Condition:   Partly cloudy
  Temperature: 18°C (feels like 17°C)
  Humidity:    65%
  Wind:        15 km/h SW
  Visibility:  10 km
  Pressure:    1015 hPa
```

## License

MIT
