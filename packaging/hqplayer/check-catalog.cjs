const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { assertCompatibleCatalog } = require('../../electron/nativeAudio/componentVersions.cjs');

// Retain every compatible approved HQPlayer version across Folia updates.
const ref = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(ref || '')) throw new Error('A base commit SHA is required');
let previous;
try { previous = JSON.parse(execFileSync('git', ['show', `${ref}:electron/hqplayer/component-catalog.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
catch (error) {
    if (!String(error.stderr).includes('does not exist') && !String(error.stderr).includes('exists on disk, but not in')) throw error;
    previous = { schema: 1, releases: [] }; // First introduction has no previous catalog.
}
assertCompatibleCatalog(previous, JSON.parse(fs.readFileSync('electron/hqplayer/component-catalog.json', 'utf8')));
