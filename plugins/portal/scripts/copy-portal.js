const fs = require('fs');
const path = require('path');

const dest = path.resolve(__dirname, '..', 'site');

// Start from an empty directory so assets of an older build are not kept
fs.rmSync(dest, { recursive: true, force: true });

// Source 1: sibling repo (development)
const devSrc = path.resolve(__dirname, '..', '..', '..', '..', 'cli-server-dashboard', 'portal', 'dist');
if (fs.existsSync(path.join(devSrc, 'index.html'))) {
    fs.cpSync(devSrc, dest, { recursive: true });
    console.log('Portal site copied from dev repo');
    process.exit(0);
}

// Source 2: npm package
try {
    const pkgPath = require.resolve('@qodalis/cli-server-portal/package.json');
    const npmSrc = path.join(path.dirname(pkgPath), 'dist');
    if (fs.existsSync(path.join(npmSrc, 'index.html'))) {
        fs.cpSync(npmSrc, dest, { recursive: true });
        console.log('Portal site copied from npm package');
        process.exit(0);
    }
} catch {
    // Not installed
}

console.warn('Warning: portal site not found — the portal will not be served');
