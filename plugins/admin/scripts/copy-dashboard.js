const fs = require('fs');
const path = require('path');

const dest = path.resolve(__dirname, '..', 'dashboard');

// Source 1: sibling repo (development)
const devSrc = path.resolve(__dirname, '..', '..', '..', '..', 'cli-server-dashboard', 'dist');
if (fs.existsSync(devSrc)) {
    fs.cpSync(devSrc, dest, { recursive: true });
    console.log('Dashboard copied from dev repo');
    process.exit(0);
}

// Source 2: npm package
try {
    const pkgPath = require.resolve('@qodalis/cli-server-dashboard/package.json');
    const npmSrc = path.join(path.dirname(pkgPath), 'dist');
    if (fs.existsSync(npmSrc)) {
        fs.cpSync(npmSrc, dest, { recursive: true });
        console.log('Dashboard copied from npm package');
        process.exit(0);
    }
} catch {
    // Not installed
}

console.warn('Warning: Dashboard dist not found — dashboard will not be available');
