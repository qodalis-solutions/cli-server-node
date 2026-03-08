import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@qodalis/cli-server-abstractions': path.resolve(
                __dirname,
                'packages/abstractions/src/index.ts',
            ),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        exclude: ['dist/**', 'node_modules/**', 'packages/**', 'demo/**'],
    },
});
