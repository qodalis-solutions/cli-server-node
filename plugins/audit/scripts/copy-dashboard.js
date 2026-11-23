const fs = require('fs');
const path = require('path');

// The Audit page of the dashboard (@qodalis/cli-dashboard-module-audit), served at /qcli/modules/audit
const dest = path.resolve(__dirname, '..', 'dashboard');

// Start from an empty directory so assets of an older build are not kept
fs.rmSync(dest, { recursive: true, force: true });

// Source 1: sibling repo (development)
const devSrc = path.resolve(__dirname, '..', '..', '..', '..', 'cli-server-dashboard', 'modules', 'audit', 'dist');
if (fs.existsSync(path.join(devSrc, 'extension.js'))) {
    fs.cpSync(devSrc, dest, { recursive: true });
    console.log('Audit page copied from dev repo');
    process.exit(0);
}

// Source 2: npm package
try {
    const pkgPath = require.resolve('@qodalis/cli-dashboard-module-audit/package.json');
    const npmSrc = path.join(path.dirname(pkgPath), 'dist');
    if (fs.existsSync(path.join(npmSrc, 'extension.js'))) {
        fs.cpSync(npmSrc, dest, { recursive: true });
        console.log('Audit page copied from npm package');
        process.exit(0);
    }
} catch {
    // Not installed
}

console.warn('Warning: the Audit page was not found; the dashboard will not show it');
