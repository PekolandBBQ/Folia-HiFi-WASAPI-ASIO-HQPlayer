"use strict";

// build/beforePack.cjs
// Resolves electron-builder's target architecture and prepares its pinned FFmpeg runtime.

const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

exports.default = async (context) => {
  const arch = ARCH_NAMES[context.arch];
  if (!arch)
    throw new Error(
      `Unsupported electron-builder architecture ordinal: ${context.arch}`,
    );
  const { prepareBundledFfmpeg } = await import(
    "../packaging/ffmpeg/fetch-ffmpeg.mjs"
  );
  await prepareBundledFfmpeg({ platform: context.electronPlatformName, arch });
  if (context.packager.config.extraMetadata?.nativeAudioEdition) {
    if (context.electronPlatformName !== 'win32') throw new Error('The native audio edition requires Windows');
    if (arch !== 'x64') throw new Error('This native audio branch supports Windows x64 only');
    const { buildNativeAudio } = await import('../packaging/windows/build-native-audio.mjs');
    await buildNativeAudio();
  }
};
