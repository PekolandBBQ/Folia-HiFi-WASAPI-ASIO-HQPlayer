const fs = require('node:fs');
const path = require('node:path');

// electron/hqplayer/wavCandidateManager.cjs — isolated listening build; never changes installed component pointers.
function withWavCandidate(manager, { app, resourcesPath = process.resourcesPath, release } = {}) {
    if (!release) { try { release = require('../release.json'); } catch {} }
    if (!app?.isPackaged || release?.candidate !== 'spotify-home-wav-listening') return manager;
    const directory = release.wavHttpRevision === 4 ? 'hqplayer-wav-tailfix' : release.wavHttpRevision === 3 ? 'hqplayer-wav-addressfix'
        : release.wavHttpRevision === 2 ? 'hqplayer-wav-readfix' : 'hqplayer-wav-test';
    const executable = path.join(resourcesPath, directory, 'hqplayer-component.cjs');
    return { ...manager,
        status: async () => ({ available: fs.existsSync(executable), installed: true, enabled: true,
            version: '0.1.4-preview.7', executable, listeningCandidate: true, inputContainer: 'wav' }),
        install: async () => { throw new Error('试听版使用随包 WAV 组件，不更改已安装组件'); },
        uninstall: async () => { throw new Error('试听版保留已安装组件'); },
        rollback: async () => { throw new Error('请打开正式版使用原有组件'); },
    };
}
module.exports = { withWavCandidate };
