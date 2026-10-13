const { spawn } = require('node:child_process');
const { spotifyError } = require('./errors.cjs');

// The same compatibility contract guards installation and each credential-bearing session.
function assertHello(value, { action, version } = {}) {
  if (value?.event !== 'hello' || value.component !== 'folia-spotify-playback' || value.protocolVersion !== 1
    || !/^\d+\.\d+\.\d+$/.test(value.version || '') || (version && value.version !== version)
    || !Array.isArray(value.capabilities) || (action && !value.capabilities.includes(action)))
    throw spotifyError('unavailable', 'native-incompatible');
  return value;
}
function verifyExecutable(executable, version, { spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, buffer = '', done = false;
    const finish = (error, hello) => {
      if (done) return; done = true; clearTimeout(timer); child?.kill();
      if (error) reject(error); else resolve(hello);
    };
    const timer = setTimeout(() => finish(spotifyError('unavailable', 'native-handshake-timeout')), timeoutMs);
    try { child = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(spotifyError('unavailable', 'native-start-failed')); return; }
    child.once('error', () => finish(spotifyError('unavailable', 'native-start-failed')));
    child.once('close', () => finish(spotifyError('unavailable', 'native-incompatible')));
    child.stdout.on('data', chunk => {
      if (done) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 16384) { finish(spotifyError('invalid-response', 'native-response-limit')); return; }
      const end = buffer.indexOf('\n'); if (end < 0) return;
      try {
        const hello = assertHello(JSON.parse(buffer.slice(0, end)), { version, action: 'audio' });
        for (const action of ['status', 'song', 'playlists', 'playlist', 'playlistTracks', 'album', 'albumTracks']) assertHello(hello, { action });
        finish(null, hello);
      } catch { finish(spotifyError('unavailable', 'native-incompatible')); }
    });
  });
}
module.exports = { assertHello, verifyExecutable };
