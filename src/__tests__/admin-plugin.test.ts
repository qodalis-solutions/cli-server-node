import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import http from 'http';
import { WebSocket } from 'ws';
import { CliAdminBuilder, CliAdminPluginResult } from '../../plugins/admin';
import { CliCommandRegistry } from '../services/cli-command-registry';
import { CliEventSocketManager } from '../services/cli-event-socket-manager';
import { CliLogSocketManager } from '../services/cli-log-socket-manager';
import { CliBuilder } from '../extensions/cli-builder';
import { ICliCommandProcessor } from '../abstractions/cli-command-processor';
import { DefaultLibraryAuthor } from '../abstractions/cli-command-author';
import { ICliModule } from '@qodalis/cli-server-abstractions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JWT_SECRET = 'test-secret-for-admin-smoke-tests';
const ADMIN_USER = 'testadmin';
const ADMIN_PASS = 'testpass';

function makeProcessor(command: string): ICliCommandProcessor {
    return {
        command,
        description: `${command} processor`,
        author: DefaultLibraryAuthor,
        version: '1.0.0',
        handleAsync: async () => `${command} result`,
    };
}

const testModule: ICliModule = {
    name: 'Test Module',
    description: 'A test module for smoke tests',
    version: '1.0.0',
    author: { name: 'Test Author' },
    processors: [makeProcessor('test-cmd-1'), makeProcessor('test-cmd-2')],
};

let app: Express;
let server: http.Server;
let adminPlugin: CliAdminPluginResult;
let eventSocketManager: CliEventSocketManager;
let logSocketManager: CliLogSocketManager;
let token: string;

async function login(): Promise<string> {
    const res = await request(app)
        .post('/api/v1/qcli/auth/login')
        .send({ username: ADMIN_USER, password: ADMIN_PASS });
    return res.body.token;
}

function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
    const registry = new CliCommandRegistry();
    const builder = new CliBuilder(registry);

    builder.addProcessor(makeProcessor('echo'));
    builder.addProcessor(makeProcessor('greet'));
    builder.addModule(testModule);

    eventSocketManager = new CliEventSocketManager();
    logSocketManager = new CliLogSocketManager();

    adminPlugin = new CliAdminBuilder()
        .setCredentials(ADMIN_USER, ADMIN_PASS)
        .setJwtSecret(JWT_SECRET)
        .setRegisteredJobs(2)
        .build({
            registry,
            eventSocketManager,
            builder,
            broadcastFn: (msg) => {
                eventSocketManager.broadcastMessage(msg);
                if (msg.type === 'log:entry') {
                    logSocketManager.broadcastLog(
                        String(msg.level ?? 'information'),
                        String(msg.message ?? ''),
                        msg.source ? String(msg.source) : undefined,
                    );
                }
            },
        });

    app = express();
    app.use(express.json());
    app.use(adminPlugin.prefix, adminPlugin.router);

    server = app.listen(0); // random port
    eventSocketManager.attach(server);
    logSocketManager.attach(server);

    token = await login();
});

afterAll(async () => {
    adminPlugin?.logBuffer.restoreConsole();
    if (eventSocketManager) await eventSocketManager.broadcastDisconnect();
    if (logSocketManager) await logSocketManager.broadcastDisconnect();
    server?.close();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('Admin Auth', () => {
    it('POST /auth/login — success', async () => {
        const res = await request(app)
            .post('/api/v1/qcli/auth/login')
            .send({ username: ADMIN_USER, password: ADMIN_PASS })
            .expect(200);

        expect(res.body).toHaveProperty('token');
        expect(res.body.expiresIn).toBe(86400);
        expect(res.body.username).toBe(ADMIN_USER);
    });

    it('POST /auth/login — wrong credentials returns 401', async () => {
        const res = await request(app)
            .post('/api/v1/qcli/auth/login')
            .send({ username: 'wrong', password: 'wrong' })
            .expect(401);

        expect(res.body.error).toBe('Invalid credentials');
    });

    it('POST /auth/login — missing fields returns 400', async () => {
        await request(app)
            .post('/api/v1/qcli/auth/login')
            .send({})
            .expect(400);
    });

    it('GET /auth/me — returns user info', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/auth/me'),
        ).expect(200);

        expect(res.body.username).toBe(ADMIN_USER);
        expect(res.body).toHaveProperty('authenticatedAt');
    });

    it('GET /auth/me — no token returns 401', async () => {
        await request(app)
            .get('/api/v1/qcli/auth/me')
            .expect(401);
    });

    it('GET /auth/me — invalid token returns 401', async () => {
        await request(app)
            .get('/api/v1/qcli/auth/me')
            .set('Authorization', 'Bearer invalid-token')
            .expect(401);
    });

    it('authenticated endpoints reject missing token', async () => {
        await request(app).get('/api/v1/qcli/status').expect(401);
        await request(app).get('/api/v1/qcli/plugins').expect(401);
        await request(app).get('/api/v1/qcli/config').expect(401);
        await request(app).get('/api/v1/qcli/logs').expect(401);
        await request(app).get('/api/v1/qcli/ws/clients').expect(401);
    });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('Admin Status', () => {
    it('GET /status — returns server status', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/status'),
        ).expect(200);

        expect(res.body).toHaveProperty('uptimeSeconds');
        expect(res.body).toHaveProperty('startedAt');
        expect(res.body).toHaveProperty('memoryUsageMb');
        expect(res.body.platform).toBe('node');
        expect(res.body.platformVersion).toBe(process.version);
        expect(typeof res.body.activeWsConnections).toBe('number');
        expect(typeof res.body.activeShellSessions).toBe('number');
        expect(typeof res.body.registeredCommands).toBe('number');
        expect(res.body.registeredJobs).toBe(2);
        expect(res.body.os).toBe(process.platform);
    });
});

// ---------------------------------------------------------------------------
// Plugins (modules)
// ---------------------------------------------------------------------------

describe('Admin Plugins', () => {
    it('GET /plugins — lists registered modules', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/plugins'),
        ).expect(200);

        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBeGreaterThanOrEqual(1);

        const testMod = res.body.find((m: any) => m.name === 'Test Module');
        expect(testMod).toBeDefined();
        expect(testMod.id).toBe('test-module');
        expect(testMod.version).toBe('1.0.0');
        expect(testMod.enabled).toBe(true);
        expect(testMod.processorCount).toBe(2);
    });

    it('POST /plugins/:id/toggle — toggles module', async () => {
        const res = await authed(
            request(app).post('/api/v1/qcli/plugins/test-module/toggle'),
        ).expect(200);

        expect(res.body.id).toBe('test-module');
        expect(res.body.enabled).toBe(false);

        // Toggle back
        const res2 = await authed(
            request(app).post('/api/v1/qcli/plugins/test-module/toggle'),
        ).expect(200);

        expect(res2.body.enabled).toBe(true);
    });

    it('POST /plugins/:id/toggle — unknown module returns 404', async () => {
        await authed(
            request(app).post('/api/v1/qcli/plugins/nonexistent/toggle'),
        ).expect(404);
    });
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe('Admin Config', () => {
    it('GET /config — returns config sections', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/config'),
        ).expect(200);

        expect(res.body).toHaveProperty('sections');
        expect(Array.isArray(res.body.sections)).toBe(true);

        const names = res.body.sections.map((s: any) => s.name);
        expect(names).toContain('server');
        expect(names).toContain('auth');
        expect(names).toContain('custom');

        const serverSection = res.body.sections.find((s: any) => s.name === 'server');
        expect(serverSection.mutable).toBe(false);
        const platformEntry = serverSection.settings.find((e: any) => e.key === 'platform');
        expect(platformEntry.value).toBe('node');
    });

    it('PUT /config — updates mutable settings', async () => {
        const res = await authed(
            request(app)
                .put('/api/v1/qcli/config')
                .send({ theme: 'dark', maxLogSize: 500 }),
        ).expect(200);

        expect(res.body.message).toBe('Settings updated');
        expect(res.body.settings.theme).toBe('dark');
        expect(res.body.settings.maxLogSize).toBe(500);

        // Verify custom settings appear in GET
        const getRes = await authed(
            request(app).get('/api/v1/qcli/config'),
        ).expect(200);

        const customSection = getRes.body.sections.find((s: any) => s.name === 'custom');
        const themeEntry = customSection.settings.find((e: any) => e.key === 'theme');
        expect(themeEntry.value).toBe('dark');
    });

    it('PUT /config — null body returns 400', async () => {
        await authed(
            request(app)
                .put('/api/v1/qcli/config')
                .set('Content-Type', 'application/json')
                .send('null'),
        ).expect(400);
    });
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

describe('Admin Logs', () => {
    it('GET /logs — returns log entries', async () => {
        // The admin plugin intercepts console, so there should be entries
        const res = await authed(
            request(app).get('/api/v1/qcli/logs'),
        ).expect(200);

        expect(res.body).toHaveProperty('entries');
        expect(res.body).toHaveProperty('total');
        expect(Array.isArray(res.body.entries)).toBe(true);
    });

    it('GET /logs — supports level filter', async () => {
        // Push a known log entry
        adminPlugin.logBuffer.push({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            message: 'smoke-test-error-entry',
            source: 'test',
        });

        const res = await authed(
            request(app).get('/api/v1/qcli/logs?level=ERROR'),
        ).expect(200);

        expect(res.body.entries.every((e: any) => e.level === 'ERROR')).toBe(true);
        const found = res.body.entries.find((e: any) => e.message === 'smoke-test-error-entry');
        expect(found).toBeDefined();
    });

    it('GET /logs — supports search filter', async () => {
        adminPlugin.logBuffer.push({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            message: 'unique-search-token-xyz123',
            source: 'test',
        });

        const res = await authed(
            request(app).get('/api/v1/qcli/logs?search=unique-search-token-xyz123'),
        ).expect(200);

        expect(res.body.total).toBeGreaterThanOrEqual(1);
        expect(res.body.entries[0].message).toContain('unique-search-token-xyz123');
    });

    it('GET /logs — supports pagination', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/logs?limit=2&offset=0'),
        ).expect(200);

        expect(res.body.entries.length).toBeLessThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------
// WebSocket Clients
// ---------------------------------------------------------------------------

describe('Admin WS Clients', () => {
    it('GET /ws/clients — returns array', async () => {
        const res = await authed(
            request(app).get('/api/v1/qcli/ws/clients'),
        ).expect(200);

        expect(Array.isArray(res.body)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// CliLogSocketManager (unit)
// ---------------------------------------------------------------------------

describe('CliLogSocketManager', () => {
    describe('shouldSendLog', () => {
        it('null filter passes everything', () => {
            expect(CliLogSocketManager.shouldSendLog(null, 'debug')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog(null, 'fatal')).toBe(true);
        });

        it('filters by severity level', () => {
            expect(CliLogSocketManager.shouldSendLog('warning', 'debug')).toBe(false);
            expect(CliLogSocketManager.shouldSendLog('warning', 'information')).toBe(false);
            expect(CliLogSocketManager.shouldSendLog('warning', 'warning')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog('warning', 'error')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog('warning', 'fatal')).toBe(true);
        });

        it('is case-insensitive', () => {
            expect(CliLogSocketManager.shouldSendLog('WARNING', 'error')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog('Warning', 'debug')).toBe(false);
        });

        it('handles aliases (INFO -> information, WARN -> warning)', () => {
            expect(CliLogSocketManager.shouldSendLog('info', 'error')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog('warn', 'debug')).toBe(false);
            expect(CliLogSocketManager.shouldSendLog('warn', 'warning')).toBe(true);
        });

        it('unknown levels always pass', () => {
            expect(CliLogSocketManager.shouldSendLog('custom', 'error')).toBe(true);
            expect(CliLogSocketManager.shouldSendLog('warning', 'custom')).toBe(true);
        });
    });

    describe('formatLogMessage', () => {
        it('returns valid JSON with expected fields', () => {
            const raw = CliLogSocketManager.formatLogMessage('INFO', 'hello world', 'test');
            const msg = JSON.parse(raw);

            expect(msg.type).toBe('log');
            expect(msg.level).toBe('information'); // INFO -> information
            expect(msg.message).toBe('hello world');
            expect(msg.category).toBe('test');
            expect(msg).toHaveProperty('timestamp');
        });

        it('normalizes level aliases', () => {
            expect(JSON.parse(CliLogSocketManager.formatLogMessage('WARN', 'x')).level).toBe('warning');
            expect(JSON.parse(CliLogSocketManager.formatLogMessage('ERR', 'x')).level).toBe('error');
        });

        it('category defaults to null', () => {
            const msg = JSON.parse(CliLogSocketManager.formatLogMessage('debug', 'x'));
            expect(msg.category).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// WebSocket log streaming (integration)
// ---------------------------------------------------------------------------

describe('WebSocket Log Streaming', () => {
    function getServerPort(): number {
        const addr = server.address();
        if (typeof addr === 'object' && addr) return addr.port;
        throw new Error('Server not listening');
    }

    it('connects to /ws/qcli/logs and receives connected message', async () => {
        const port = getServerPort();
        const ws = new WebSocket(`ws://localhost:${port}/ws/qcli/logs`);

        const msg = await new Promise<string>((resolve, reject) => {
            ws.on('message', (data) => resolve(data.toString()));
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        const parsed = JSON.parse(msg);
        expect(parsed.type).toBe('connected');

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('connects to /ws/v1/qcli/logs and receives connected message', async () => {
        const port = getServerPort();
        const ws = new WebSocket(`ws://localhost:${port}/ws/v1/qcli/logs`);

        const msg = await new Promise<string>((resolve, reject) => {
            ws.on('message', (data) => resolve(data.toString()));
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        expect(JSON.parse(msg).type).toBe('connected');

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('receives broadcasted log messages', async () => {
        const port = getServerPort();
        const ws = new WebSocket(`ws://localhost:${port}/ws/qcli/logs`);

        // Wait for connected message first
        await new Promise<void>((resolve, reject) => {
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'connected') resolve();
            });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        // Set up listener for log messages
        const logPromise = new Promise<any>((resolve, reject) => {
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'log' && msg.message === 'ws-broadcast-test') {
                    resolve(msg);
                }
            });
            setTimeout(() => reject(new Error('timeout waiting for log')), 3000);
        });

        // Broadcast a log
        logSocketManager.broadcastLog('information', 'ws-broadcast-test', 'smoke-test');

        const logMsg = await logPromise;
        expect(logMsg.level).toBe('information');
        expect(logMsg.message).toBe('ws-broadcast-test');
        expect(logMsg.category).toBe('smoke-test');

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('respects level filter on connection', async () => {
        const port = getServerPort();
        const ws = new WebSocket(`ws://localhost:${port}/ws/qcli/logs?level=error`);

        // Wait for connected
        await new Promise<void>((resolve, reject) => {
            ws.on('message', (data) => {
                if (JSON.parse(data.toString()).type === 'connected') resolve();
            });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        const received: any[] = [];
        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'log') received.push(msg);
        });

        // Send logs at different levels
        logSocketManager.broadcastLog('debug', 'should-be-filtered');
        logSocketManager.broadcastLog('information', 'should-be-filtered');
        logSocketManager.broadcastLog('error', 'should-pass-filter');
        logSocketManager.broadcastLog('fatal', 'should-also-pass');

        await new Promise((r) => setTimeout(r, 200));

        // Only error and fatal should have been received
        expect(received.length).toBe(2);
        expect(received[0].level).toBe('error');
        expect(received[1].level).toBe('fatal');

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
    });

    it('getClients returns connected log clients', async () => {
        const port = getServerPort();
        const ws = new WebSocket(`ws://localhost:${port}/ws/qcli/logs?level=warning`);

        await new Promise<void>((resolve, reject) => {
            ws.on('message', (data) => {
                if (JSON.parse(data.toString()).type === 'connected') resolve();
            });
            ws.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        const clients = logSocketManager.getClients();
        expect(clients.length).toBeGreaterThanOrEqual(1);

        const client = clients.find((c) => c.levelFilter === 'warning');
        expect(client).toBeDefined();
        expect(client!.type).toBe('logs');
        expect(client!.id).toMatch(/^log-/);
        expect(client!).toHaveProperty('connectedAt');
        expect(client!).toHaveProperty('remoteAddress');

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
    });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Auth Rate Limiting', () => {
    it('blocks after 5 failed attempts', async () => {
        // Use a fresh app to avoid contaminating other tests' rate limit state
        const freshRegistry = new CliCommandRegistry();
        const freshBuilder = new CliBuilder(freshRegistry);
        const freshEsm = new CliEventSocketManager();

        const freshAdmin = new CliAdminBuilder()
            .setCredentials('ratelimit-user', 'ratelimit-pass')
            .setJwtSecret('rate-limit-secret')
            .build({ registry: freshRegistry, eventSocketManager: freshEsm, builder: freshBuilder });

        const freshApp = express();
        freshApp.use(express.json());
        // Express needs trust proxy for req.ip in testing
        freshApp.set('trust proxy', true);
        freshApp.use(freshAdmin.prefix, freshAdmin.router);

        // 5 failed attempts
        for (let i = 0; i < 5; i++) {
            await request(freshApp)
                .post('/api/v1/qcli/auth/login')
                .send({ username: 'wrong', password: 'wrong' })
                .expect(401);
        }

        // 6th attempt should be rate limited
        const res = await request(freshApp)
            .post('/api/v1/qcli/auth/login')
            .send({ username: 'wrong', password: 'wrong' })
            .expect(429);

        expect(res.body.error).toContain('Too many');

        freshAdmin.logBuffer.restoreConsole();
    });
});
