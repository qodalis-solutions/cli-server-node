const fs = require('fs');
const path = require('path');

// The Filesystem page of the dashboard (@qodalis/cli-dashboard-module-filesystem), served at /qcli/modules/filesystem
const dest = path.resolve(__dirname, '..', 'dashboard');

// Start from an empty directory so assets of an older build are not kept
fs.rmSync(dest, { recursive: true, force: true });

// Source 1: sibling repo (development)
const devSrc = path.resolve(__dirname, '..', '..', '..', '..', 'cli-server-dashboard', 'modules', 'filesystem', 'dist');
if (fs.existsSync(path.join(devSrc, 'extension.js'))) {
    fs.cpSync(devSrc, dest, { recursive: true });
    console.log('Filesystem page copied from dev repo');
    process.exit(0);
}

// Source 2: npm package
try {
    const pkgPath = require.resolve('@qodalis/cli-dashboard-module-filesystem/package.json');
    const npmSrc = path.join(path.dirname(pkgPath), 'dist');
    if (fs.existsSync(path.join(npmSrc, 'extension.js'))) {
        fs.cpSync(npmSrc, dest, { recursive: true });
        console.log('Filesystem page copied from npm package');
        process.exit(0);
    }
} catch {
    // Not installed
}

console.warn('Warning: the Filesystem page was not found; the dashboard will not show it');
