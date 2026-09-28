const fs = require('node:fs');
const path = require('node:path');

// packaging/exclusive/profile.cjs — fork-only, non-destructive profile migration.
function prepareProfile(appData, profileName, legacyName, fileSystem = fs) {
    const root = path.resolve(appData);
    for (const name of [profileName, legacyName]) {
        if (!name || name === '.' || name === '..' || path.basename(name) !== name) throw new Error('Invalid profile name');
    }
    const target = path.join(root, profileName), legacy = path.join(root, legacyName);
    if (fileSystem.existsSync(target)) return target;
    if (!fileSystem.existsSync(legacy)) {
        fileSystem.mkdirSync(target, { recursive: true });
        return target;
    }
    // Publish only a complete copy. Existing destinations and the legacy profile
    // are never merged, removed, or overwritten, including on a copy failure.
    const staging = fileSystem.mkdtempSync(path.join(root, `${profileName}.migration-`));
    try {
        fileSystem.cpSync(legacy, staging, {
            recursive: true,
            filter: source => !/^(SingletonLock|SingletonCookie|SingletonSocket|lockfile)$/.test(path.basename(source)),
        });
        fileSystem.renameSync(staging, target);
    } catch (error) {
        if (path.dirname(path.resolve(staging)) === root && path.basename(staging).startsWith(`${profileName}.migration-`)) {
            try { fileSystem.rmSync(staging, { recursive: true, force: true }); } catch { /* Leave failed staging for diagnosis. */ }
        }
        throw error;
    }
    return target;
}
module.exports = { prepareProfile };
