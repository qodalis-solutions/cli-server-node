import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@qodalis/cli-server-abstractions': path.resolve(
                __dirname,
                'packages/abstractions/src/index.ts',
            ),
            '@qodalis/cli-server-plugin-filesystem': path.resolve(
                __dirname,
                'plugins/filesystem/index.ts',
            ),
            '@qodalis/cli-server-plugin-filesystem-json': path.resolve(
                __dirname,
                'plugins/filesystem-json/index.ts',
            ),
            '@qodalis/cli-server-plugin-filesystem-sqlite': path.resolve(
                __dirname,
                'plugins/filesystem-sqlite/index.ts',
            ),
            '@qodalis/cli-server-plugin-filesystem-s3': path.resolve(
                __dirname,
                'plugins/filesystem-s3/index.ts',
            ),
            '@qodalis/cli-server-plugin-weather': path.resolve(
                __dirname,
                'plugins/weather/index.ts',
            ),
            '@qodalis/cli-server-plugin-jobs': path.resolve(
                __dirname,
                'plugins/jobs/index.ts',
            ),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        exclude: ['dist/**', 'node_modules/**', 'packages/**', 'demo/**'],
    },
});
