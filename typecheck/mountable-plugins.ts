/**
 * Type-only check that every plugin's build result mounts with `mountPlugin`, as an app compiles it. The tests
 * and the per-plugin builds never put a plugin's result next to the server's `MountablePlugin`, so a loosely typed
 * field (the admin plugin's `mcpProviders` returned `unknown[]` tools in 1.0.0-beta.34) only failed in apps.
 * Run by CI: `npx tsc -p tsconfig.typecheck.json`.
 */
import type { MountablePlugin } from '../src/create-cli-server';
import type { CliAdminPluginResult } from '../plugins/admin/cli-admin-builder';
import type { CliDatabasesPluginResult } from '../plugins/databases/builder';
import type { CliJobsPluginResult } from '../plugins/jobs/cli-jobs-builder';
import type { UsersPluginResult } from '../plugins/users/cli-users-builder';

type Mountable<T extends MountablePlugin> = T;

export type Checked = [
    Mountable<CliAdminPluginResult>,
    Mountable<CliDatabasesPluginResult>,
    Mountable<CliJobsPluginResult>,
    Mountable<UsersPluginResult>,
];
