/**
 * The admin plugin finds the dashboard build the same way whether it runs
 * compiled (plugins/admin/dist) or from source (tsx, vitest).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveDashboardDir } from '../../plugins/admin/services/dashboard-dir';

describe('resolveDashboardDir', () => {
    let root: string;
    let pluginDir: string;
    let siblingDist: string;

    const makeBuild = (dir: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.html'), '<html></html>');
    };

    beforeEach(() => {
        // <root>/cli-server-node/plugins/admin and <root>/cli-server-dashboard/dist
        root = mkdtempSync(join(tmpdir(), 'qcli-dashboard-'));
        pluginDir = join(root, 'cli-server-node', 'plugins', 'admin');
        mkdirSync(join(pluginDir, 'dist'), { recursive: true });
        writeFileSync(join(pluginDir, 'package.json'), '{}');
        siblingDist = join(root, 'cli-server-dashboard', 'dist');
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('finds the sibling dashboard build from source and from dist', () => {
        makeBuild(siblingDist);
        expect(resolveDashboardDir(undefined, pluginDir, root)).toBe(siblingDist);
        expect(resolveDashboardDir(undefined, join(pluginDir, 'dist'), root)).toBe(siblingDist);
    });

    it('prefers the sibling build over the bundled copy', () => {
        makeBuild(siblingDist);
        makeBuild(join(pluginDir, 'dashboard'));
        expect(resolveDashboardDir(undefined, pluginDir, root)).toBe(siblingDist);
    });

    it('uses the bundled copy when there is no sibling build', () => {
        makeBuild(join(pluginDir, 'dashboard'));
        expect(resolveDashboardDir(undefined, join(pluginDir, 'dist'), root)).toBe(
            join(pluginDir, 'dashboard'),
        );
    });

    it('prefers an explicit directory', () => {
        makeBuild(siblingDist);
        const custom = join(root, 'custom');
        makeBuild(custom);
        expect(resolveDashboardDir(custom, pluginDir, root)).toBe(custom);
    });

    it('skips a directory without index.html', () => {
        mkdirSync(siblingDist, { recursive: true });
        makeBuild(join(pluginDir, 'dashboard'));
        expect(resolveDashboardDir(undefined, pluginDir, root)).toBe(join(pluginDir, 'dashboard'));
    });
});
