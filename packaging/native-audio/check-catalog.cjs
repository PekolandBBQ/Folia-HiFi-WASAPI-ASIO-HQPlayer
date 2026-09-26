const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { assertCompatibleCatalog } = require('../../electron/nativeAudio/componentVersions.cjs');
const { validateRelease } = require('../../electron/nativeAudio/componentManager.cjs');

// packaging/native-audio/check-catalog.cjs — CI retains compatible versions and Folia-owned URLs.
const file = 'electron/nativeAudio/component-catalog.json';
const next = JSON.parse(fs.readFileSync(file, 'utf8'));
if (next.schema !== 1 || !Array.isArray(next.releases)) throw new Error('Invalid catalog');
for (const release of next.releases) {
    validateRelease(release);
    if (!/^https:\/\/github\.com\/chthollyphile\/folia-major\/releases\/download\//.test(release.url || '') || release.localPath)
        throw new Error('Production catalog must use Folia release URLs only');
}
const base = process.argv[2];
if (base) {
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Expected base commit SHA');
    const exists = execFileSync('git', ['ls-tree', base, '--', file], { encoding: 'utf8' }).trim();
    if (exists) assertCompatibleCatalog(JSON.parse(execFileSync('git', ['show', `${base}:${file}`], { encoding: 'utf8' })), next);
}
console.log('通过：兼容版本保留和分发地址检查 / PASS: compatible catalog retention and distribution URLs');
