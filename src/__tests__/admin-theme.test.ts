import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    ADMIN_THEME_TOKENS,
    CliAdminBuilder,
    isThemeColor,
    validateAdminTheme,
} from '../../plugins/admin';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliEventSocketManager } from '../services/cli-event-socket-manager';
import { CliBuilder } from '../extensions/cli-builder';

describe('isThemeColor', () => {
    it.each([
        '#fff', '#ffff', '#4f46e5', '#4f46e5cc', 'rgb(1, 2, 3)', 'rgba(255,255,255,0.04)',
        'rgb(1 2 3 / 50%)', 'hsl(240deg 100% 50%)', 'oklch(0.7 0.1 250)', 'transparent', 'rebeccapurple',
    ])('accepts %s', (value) => {
        expect(isThemeColor(value)).toBe(true);
    });

    it.each([
        '', '#ggg', '#12345', 'red;}body{display:none', 'url(https://x)', 'var(--x)',
        'rgb(1,2,3);color:red', 'expression(alert(1))', '"red"', 'rgb(calc(1),2,3)',
        '</style><script>', 42, null, 'x'.repeat(101),
    ])('rejects %s', (value) => {
        expect(isThemeColor(value)).toBe(false);
    });
});

describe('validateAdminTheme', () => {
    it('defaults to dark with no overrides', () => {
        expect(validateAdminTheme(undefined)).toEqual({ mode: 'dark', dark: {}, light: {} });
    });

    it('keeps valid overrides, trimmed', () => {
        expect(validateAdminTheme({ mode: 'system', light: { primary: ' #2a6bba ' }, dark: { surface: 'rgb(19 33 47)' } }))
            .toEqual({ mode: 'system', light: { primary: '#2a6bba' }, dark: { surface: 'rgb(19 33 47)' } });
    });

    it('accepts every token', () => {
        const all = Object.fromEntries(ADMIN_THEME_TOKENS.map((t) => [t, '#000000']));
        expect(validateAdminTheme({ dark: all }).dark).toEqual(all);
    });

    it('rejects an invalid mode', () => {
        expect(() => validateAdminTheme({ mode: 'neon' as never })).toThrow(/mode/);
    });

    it('rejects an unknown token', () => {
        expect(() => validateAdminTheme({ dark: { brand: '#fff' } as never })).toThrow(/unknown token "dark.brand"/);
    });

    it('rejects CSS injection', () => {
        expect(() => validateAdminTheme({ light: { primary: 'red;} body{display:none' } }))
            .toThrow(/Invalid admin theme color for "light.primary"/);
    });

    it('rejects a scheme that is not an object', () => {
        expect(() => validateAdminTheme({ dark: '#fff' as never })).toThrow(/"dark" must be an object/);
    });
});

describe('GET /qcli/admin/theme.json', () => {
    function mount(builder: CliAdminBuilder) {
        const registry = new CliCommandRegistry();
        const plugin = builder
            .setCredentials('admin', 'secret')
            .build({ registry, eventSocketManager: new CliEventSocketManager(), builder: new CliBuilder(registry) });
        const app = express();
        app.use(plugin.dashboardPrefix, plugin.dashboardRouter);
        return { app, plugin };
    }

    it('serves the configured theme without authentication', async () => {
        const { app, plugin } = mount(new CliAdminBuilder().setTheme({ mode: 'light', light: { primary: '#2a6bba' } }));
        const res = await request(app).get('/qcli/admin/theme.json');
        plugin.dispose();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.headers['cache-control']).toBe('no-cache');
        expect(res.body).toEqual({ mode: 'light', dark: {}, light: { primary: '#2a6bba' } });
    });

    it('serves the defaults when no theme is set', async () => {
        const { app, plugin } = mount(new CliAdminBuilder());
        const res = await request(app).get('/qcli/admin/theme.json');
        plugin.dispose();
        expect(res.body).toEqual({ mode: 'dark', dark: {}, light: {} });
    });

    it('fails fast on an invalid theme', () => {
        expect(() => new CliAdminBuilder().setTheme({ dark: { error: 'url(x)' } })).toThrow();
    });
});
