const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// electron/nativeAudio/decoder.cjs — native playback uses the host's pinned audio-only FFmpeg slot.
async function resolveNativeDecoder(app) {
    const executable = !app.isPackaged && process.env.FOLIA_NATIVE_FFMPEG_PATH
        || (app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg-audio', 'ffmpeg.exe')
            : path.join(app.getAppPath(), 'build', 'ffmpeg', 'win-x64', 'ffmpeg.exe'));
    await fs.access(executable);
    const { stdout } = await promisify(execFile)(executable, ['-hide_banner', '-encoders'], { windowsHide: true, timeout: 8000 });
    if (!/\bpcm_s24le\b/.test(stdout) || !/\bpcm_s32le\b/.test(stdout))
        throw new Error('The Folia FFmpeg runtime requires PCM24 and PCM32 encoding support');
    return executable;
}
module.exports = { resolveNativeDecoder };
