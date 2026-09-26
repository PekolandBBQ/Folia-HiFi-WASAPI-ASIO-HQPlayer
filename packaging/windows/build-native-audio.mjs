import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareNativeDecoder } from './native-audio-decoder.mjs';

// packaging/windows/build-native-audio.mjs — ship a self-contained, pinned Windows x64 helper.
export async function buildNativeAudio() {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = spawnSync(process.env.FOLIA_DOTNET_PATH || 'dotnet', [
        'publish', path.join(root, 'native/windows-audio/Folia.Audio.csproj'), '-c', 'Release',
        '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:RestoreLockedMode=true',
        '-o', path.join(root, 'build/native-audio'),
    ], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw result.error || new Error('Native audio build failed');
    await prepareNativeDecoder(path.join(root, 'build/native-audio'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildNativeAudio();
