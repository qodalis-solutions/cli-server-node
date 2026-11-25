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

## Terminal commands

The commands are listed under [Commands](#commands); they need no permission beyond `commands:execute` on a protected
server.

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

## Install from the dashboard

Installable at runtime from the admin dashboard's Marketplace tab (Server plugins) or `admin plugins install weather`
([admin plugin](../admin/README.md#server-plugins-from-the-marketplace)): the server installs the npm package into `<dataDir>/server-plugins` and loads it at the next
start, no code ([runtime plugins](../../README.md#server-plugins-installed-at-runtime)). Its entry (`qodalis.entry`, `dist/plugin.js`) returns the weather module; the place used when a command names none is a setting, read on every command (no restart).

| Setting | Type | Default | |
|---|---|---|---|
| `defaultLocation` | string | `London` | The place when a command names none |

## License

MIT
