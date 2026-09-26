const { build } = require('../../package.json');

// packaging/windows/native-audio-builder.cjs — separate identity and data directory for this edition.
module.exports = {
    ...build,
    appId: 'top.izuna.foliamajor.nativeaudio',
    productName: 'Folia Native Audio',
    extraMetadata: { name: 'folia-major-native-audio', productName: 'Folia Native Audio', nativeAudioEdition: true },
    publish: null,
    win: {
        ...build.win,
        artifactName: 'Folia-Native-Audio-Setup-${version}-${arch}.${ext}',
        extraResources: [
            ...(build.win.extraResources || []),
            { from: 'build/native-audio', to: 'native-audio', filter: ['*.exe', '*.dll', '*.json', '*.txt'] },
        ],
    },
};
