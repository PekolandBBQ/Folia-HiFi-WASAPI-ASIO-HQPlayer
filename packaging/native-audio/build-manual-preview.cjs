const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { build, Platform } = require('electron-builder');

// packaging/native-audio/build-manual-preview.cjs — build the isolated manual validation distribution.
async function main() {
    const root = path.resolve(__dirname, '../..');
    const staging = path.join(root, 'build/manual-native-audio'); await fs.mkdir(staging, { recursive: true });
    const catalog = JSON.parse(await fs.readFile(path.resolve(root, '../folia-native-audio-component/artifacts/development-catalog.json'), 'utf8'));
    const releases = [];
    for (const release of catalog.releases) {
        const bytes = await fs.readFile(release.localPath);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Catalog hash mismatch');
        const archive = path.basename(release.localPath); await fs.writeFile(path.join(staging, archive), bytes);
        const { localPath, ...pinned } = release; releases.push({ ...pinned, archive });
    }
    const manifest = { schema: 1, purpose: 'offline-manual-validation-only', releases };
    await fs.writeFile(path.join(staging, 'manual-approved.json'), JSON.stringify(manifest, null, 2));
    const ffmpeg = path.join(root, 'build/ffmpeg/win-x64/ffmpeg.exe');
    if (crypto.createHash('sha256').update(await fs.readFile(ffmpeg)).digest('hex') !== 'd28a1c5730520de13dfe947f39366032a77eee5c4ba7e78b63fd82e409294cfb') throw new Error('Unreviewed FFmpeg runtime');
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
    if (!/\bpcm_s24le\b/.test(encoders) || !/\bpcm_s32le\b/.test(encoders)) throw new Error('PCM encoders missing');
    await fs.writeFile(path.join(root, 'build/ffmpeg/win-x64/share/folia-ffmpeg/NATIVE-CANDIDATE.txt'),
        'This is the locally validated PCM24/PCM32 candidate, not the original official FFmpeg binary.\n' +
        'Source: https://github.com/PekolandBBQ/folia-ffmpeg-build\nBuild scripts commit: 226a670\n' +
        'SHA256: d28a1c5730520de13dfe947f39366032a77eee5c4ba7e78b63fd82e409294cfb\n' +
        'BUILD-INFO.txt describes the upstream base; the actual candidate configuration follows.\n' +
        spawnSync(ffmpeg, ['-buildconf'], { encoding: 'utf8', windowsHide: true }).stderr);
    await build({ targets: Platform.WINDOWS.createTarget('dir'), config: {
        productName: 'Folia Native Validation',
        directories: { output: 'release/manual-20260929' },
        extraMetadata: { main: 'electron/manual-preview.cjs', version: '0.7.8-native.validation.20260929' },
        beforePack: async () => {}, // The reviewed PCM-enabled candidate above replaces the unpatched official FFmpeg.
        files: [
            'dist/**/*', 'electron/**/*', 'shared/**/*', 'package.json', 'build/miao.png', 'build/thumbar/*.png',
            { from: 'packaging/native-audio', to: 'electron', filter: ['manual-preview.cjs'] },
            { from: 'build/manual-native-audio', to: 'electron', filter: ['manual-approved.json'] },
        ],
        extraResources: [
            { from: 'build/ffmpeg/win-x64', to: 'ffmpeg-audio' },
            { from: 'build/manual-native-audio', to: 'manual-native-audio' },
            { from: 'build/icon.png', to: 'icon.png' },
            { from: 'build/trayTemplate.png', to: 'trayTemplate.png' },
            { from: 'build/trayTemplate@2x.png', to: 'trayTemplate@2x.png' },
        ],
        win: { signAndEditExecutable: false }, publish: null,
    }, publish: 'never' });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
