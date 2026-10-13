'use strict';
const path = require('node:path');
const { createHash } = require('node:crypto');

// Plan only: a verified clean base and its canonical installed path choose a
// separate COW generation. This never reads, moves, rebases or migrates disks.
// Main must verify the base and protect a fresh generation before Owner.start.
const fail = () => Object.assign(new Error('Spotify appliance: APPLIANCE_GENERATION_INVALID'), { code: 'APPLIANCE_GENERATION_INVALID' });
function absolute(value, platform, file) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  if (typeof value !== 'string' || !value.length || value.length > 4096 || !api.isAbsolute(value)
    || /[\x00-\x1f\x7f"<>|?*]/.test(value)) throw fail();
  const root = api.parse(value).root;
  if (platform === 'win32' && !/^[A-Za-z]:[\\/]$/.test(root)) throw fail();
  const parts = value.slice(root.length).split(platform === 'win32' ? /[\\/]/ : /\//);
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || platform === 'win32' && (part.includes(':') || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw fail();
  const result = api.resolve(value);
  if (file && !/\.qcow2$/i.test(api.basename(result))) throw fail();
  return result;
}
function planSoloistApplianceGeneration({ dataRoot, canonicalBaseImage, baseImageSha512, platform = process.platform } = {}) {
  if (process.type === 'renderer' || !['win32', 'linux', 'darwin'].includes(platform)
    || typeof baseImageSha512 !== 'string' || !/^[a-f0-9]{128}$/.test(baseImageSha512)) throw fail();
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = absolute(dataRoot, platform, false), baseImage = absolute(canonicalBaseImage, platform, true);
  // Exact canonical path case is intentional: current Owner metadata compares
  // its backing path exactly. Even a byte-identical relocated base gets a fresh
  // disk, so no old sector can silently overlay a new installed system image.
  const identity = Object.freeze({ schema: 1, baseImage, baseSha512: baseImageSha512 });
  const id = createHash('sha256').update(JSON.stringify(['folia-soloist-cow-generation-v1', baseImageSha512, baseImage])).digest('hex');
  const generationDirectory = api.join(root, 'generations', id);
  return Object.freeze({ schema: 1, id, generationDirectory, dataDirectory: api.join(generationDirectory, 'appliance-data'), identity,
    policy: Object.freeze({ oldGenerationsPreserved: true, mainVaultPreserved: true, rebaseAllowed: false,
      diskCopyAllowed: false, pairingPreservedAcrossGenerations: false, freshGenerationRequiresPairing: true }) });
}
module.exports = { planSoloistApplianceGeneration };
