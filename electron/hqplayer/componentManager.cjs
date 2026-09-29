const path = require('node:path');
const { createComponentManager } = require('../components/archiveManager.cjs');
const { createRpc, handshake } = require('./rpc.cjs');

// Independent catalog and activation pointers; shares only the audited archive installer mechanism.
function createHQPlayerComponentManager({ app, catalogPath, fetchImpl, verifyStaged } = {}) {
    return createComponentManager({ app, fetchImpl,
        catalogPath: catalogPath || (!app.isPackaged && process.env.FOLIA_HQPLAYER_COMPONENT_CATALOG) || path.join(__dirname, 'component-catalog.json'),
        descriptor: { id: 'hqplayer', entry: 'hqplayer-component.cjs',
            allowedFile: /^(?:hqplayer-component\.cjs|component\.json|LICENSE\.txt|NOTICE\.txt)$/,
            validateRelease: release => { if (!/^[a-f0-9]{64}$/.test(release.entrySha256 || '')) throw new Error('Missing HQPlayer entry digest'); } },
        verifyStaged: verifyStaged || (async (entry, release) => {
            const rpc = createRpc(entry); try { await handshake(rpc, release.version); } finally { await rpc.dispose(); }
        }) });
}
module.exports = { createHQPlayerComponentManager };
