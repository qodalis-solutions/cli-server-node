const fs = require('fs');
const path = require('path');

// The dashboard pages of this plugin: API tokens (@qodalis/cli-dashboard-module-tokens, /qcli/modules/tokens) and
// Users + Account (@qodalis/cli-dashboard-module-users, /qcli/modules/users and /qcli/modules/account)
const MODULES = [
    { name: 'tokens', title: 'API tokens page', dest: 'dashboard' },
    { name: 'users', title: 'Users page', dest: 'dashboard-users' },
];

for (const { name, title, dest: folder } of MODULES) {
    const dest = path.resolve(__dirname, '..', folder);

    // Start from an empty directory so assets of an older build are not kept
    fs.rmSync(dest, { recursive: true, force: true });

    // Source 1: sibling repo (development)
    const devSrc = path.resolve(__dirname, '..', '..', '..', '..', 'cli-server-dashboard', 'modules', name, 'dist');
    if (fs.existsSync(path.join(devSrc, 'extension.js'))) {
        fs.cpSync(devSrc, dest, { recursive: true });
        console.log(`${title} copied from dev repo`);
        continue;
    }

    // Source 2: npm package
    let copied = false;
    try {
        const pkgPath = require.resolve(`@qodalis/cli-dashboard-module-${name}/package.json`);
        const npmSrc = path.join(path.dirname(pkgPath), 'dist');
        if (fs.existsSync(path.join(npmSrc, 'extension.js'))) {
            fs.cpSync(npmSrc, dest, { recursive: true });
            console.log(`${title} copied from npm package`);
            copied = true;
        }
    } catch {
        // Not installed
    }

    if (!copied) console.warn(`Warning: the ${title} was not found; the dashboard will not show it`);
}
