import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import {
    environHasShellId,
    psLineHasShellId,
    newShellId,
    findMarkedProcesses,
    collectProcessTree,
    SHELL_ID_ENV,
} from '../services/process-tree';

const ID = 'a'.repeat(31) + 'b';

describe('process-tree: QCLI_SHELL_ID marker', () => {
    it('newShellId returns 128-bit lowercase hex, unique per call', () => {
        const a = newShellId();
        expect(a).toMatch(/^[0-9a-f]{32}$/);
        expect(newShellId()).not.toBe(a);
        expect(SHELL_ID_ENV).toBe('QCLI_SHELL_ID');
    });

    it('environHasShellId matches only the exact NUL-separated entry', () => {
        expect(environHasShellId(`PATH=/bin\0QCLI_SHELL_ID=${ID}\0HOME=/h\0`, ID)).toBe(true);
        expect(environHasShellId(`QCLI_SHELL_ID=${ID}`, ID)).toBe(true);
        expect(environHasShellId(`QCLI_SHELL_ID=${ID}x\0`, ID)).toBe(false);
        expect(environHasShellId(`QCLI_SHELL_ID=x${ID}\0`, ID)).toBe(false);
        expect(environHasShellId(`XQCLI_SHELL_ID=${ID}\0`, ID)).toBe(false);
        expect(environHasShellId(`FOO=QCLI_SHELL_ID=${ID}\0`, ID)).toBe(false);
        expect(environHasShellId(`QCLI_SHELL_ID=${'c'.repeat(32)}\0`, ID)).toBe(false);
        expect(environHasShellId('', ID)).toBe(false);
    });

    it('psLineHasShellId matches ` QCLI_SHELL_ID=<id>` as a whole token', () => {
        expect(psLineHasShellId(`  123 sleep 5 PATH=/bin QCLI_SHELL_ID=${ID} HOME=/h`, ID)).toBe(true);
        expect(psLineHasShellId(`  123 sleep 5 QCLI_SHELL_ID=${ID}`, ID)).toBe(true);
        expect(psLineHasShellId(`  123 sleep 5 QCLI_SHELL_ID=${ID}\tX=1`, ID)).toBe(true);
        expect(psLineHasShellId(`  123 sleep 5 QCLI_SHELL_ID=${ID}0 X=1`, ID)).toBe(false);
        expect(psLineHasShellId(`  123 sleep 5 XQCLI_SHELL_ID=${ID}`, ID)).toBe(false);
        expect(psLineHasShellId(`  123 sleep 5 FOO=QCLI_SHELL_ID=${ID}`, ID)).toBe(false);
        // a longer non-matching occurrence first, then the real token
        expect(psLineHasShellId(`  1 x QCLI_SHELL_ID=${ID}ff QCLI_SHELL_ID=${ID}`, ID)).toBe(true);
        expect(psLineHasShellId(`  123 sleep 5`, ID)).toBe(false);
    });

    it('findMarkedProcesses rejects malformed ids', () => {
        expect(findMarkedProcesses('')).toEqual([]);
        expect(findMarkedProcesses('.*')).toEqual([]);
    });

    describe('live processes', () => {
        let child: ChildProcess | undefined;
        afterEach(() => {
            child?.kill('SIGKILL');
            child = undefined;
        });

        it('finds a detached process (own session) by its marker, never the server itself', async () => {
            if (os.platform() === 'win32') return;
            const id = newShellId();
            // node, not `sleep`: macOS hides the environment of Apple platform binaries from `ps -E`
            child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, [SHELL_ID_ENV]: id },
            });
            await new Promise((r) => setTimeout(r, 200));
            expect(findMarkedProcesses(id)).toEqual([child.pid]);
            expect(findMarkedProcesses(newShellId())).toEqual([]);
            // collected even though it is not related to the (fake) root by pid, group or session
            const tree = collectProcessTree(2 ** 22 + 7, id);
            expect(tree).toContain(child.pid);
            expect(tree).not.toContain(process.pid);
        });
    });
});
