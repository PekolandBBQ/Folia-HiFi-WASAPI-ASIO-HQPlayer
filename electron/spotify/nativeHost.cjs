const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { spotifyError } = require('./errors.cjs');
const { assertHello } = require('./componentProtocol.cjs');

// Owns bounded native sessions. Credentials travel only through stdin, never argv or diagnostics.
const ACTIONS = new Set(['status', 'song', 'playlists', 'playlist', 'playlistTracks', 'album', 'albumTracks', 'audio', 'audio-stream', 'audio-stream-encoded']);
const isAudio = action => ['audio', 'audio-stream', 'audio-stream-encoded'].includes(action);
function createNativeHost({ vault, executable, spawnProcess = spawn, timeoutMs = 225000 }) {
  let generation = 0;
  const running = new Set();
  async function request(input, { signal, onProgress } = {}) {
    if (!ACTIONS.has(input.action)) throw spotifyError('unsupported');
    if ((['song', 'playlist', 'playlistTracks', 'album', 'albumTracks'].includes(input.action) || isAudio(input.action))
      && !/^[A-Za-z0-9]{22}$/.test(input.id || input.trackId || '')) throw spotifyError('invalid-response', 'invalid-id');
    const expected = generation;
    const token = await vault.token();
    if (expected !== generation || signal?.aborted) throw spotifyError('unavailable', 'request-cancelled');
    if (!token) { if (input.action === 'status') return null; throw spotifyError('auth-required'); }
    if (running.size >= 4) throw spotifyError('unavailable', 'native-busy');
    return new Promise((resolve, reject) => {
      let child, result, ready, failure, hello = false, streamReady = false, handshakeTimer, buffer = '', total = 0, done = false;
      const decoder = new StringDecoder('utf8');
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); clearTimeout(handshakeTimer); signal?.removeEventListener('abort', cancel); running.delete(cancel);
        if (error) { child?.kill(); reject(error); } else resolve(value);
      };
      const cancel = () => finish(spotifyError('unavailable', 'request-cancelled'));
      const timer = setTimeout(() => finish(spotifyError('network', 'native-timeout')), timeoutMs);
      running.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { child = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
      catch { finish(spotifyError('unavailable', 'native-start-failed')); return; }
      child.on('error', () => finish(spotifyError('unavailable', 'native-start-failed')));
      child.stdin.on('error', () => finish(spotifyError('network', 'native-input-failed')));
      handshakeTimer = setTimeout(() => finish(spotifyError('unavailable', 'native-handshake-timeout')), 10000);
      child.stdout.on('data', chunk => {
        if (done) return;
        total += chunk.length;
        if (total > 4 * 1024 * 1024) { finish(spotifyError('invalid-response', 'native-response-limit')); return; }
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event;
          try { event = JSON.parse(line); } catch { finish(spotifyError('invalid-response', 'native-response')); return; }
          if (!hello) {
            try { assertHello(event, { action: input.action }); }
            catch (error) { finish(error); return; }
            hello = true; clearTimeout(handshakeTimer);
            // Only a compatible helper receives the request and its credential through the private pipe.
            child.stdin.end(JSON.stringify({ action: input.action, accessToken: token, id: input.id, trackId: input.trackId,
              offset: input.offset, limit: input.limit, output: input.output, quality: input.quality }) + '\n');
          }
          else if (event.event === 'hello') { finish(spotifyError('invalid-response', 'native-duplicate-hello')); return; }
          else if (event.event === 'result') result = event.result;
          else if (event.event === 'ready') ready = event;
          else if (event.event === 'failed') failure = typeof event.code === 'string' && /^[a-z-]{1,60}$/.test(event.code) ? event.code : 'native-failed';
          else if (event.event === 'stream-ready') {
            if (input.action === 'audio' || !isAudio(input.action) || streamReady) { finish(spotifyError('invalid-response', 'native-stream-ready')); return; }
            streamReady = true;
            try { onProgress?.(event); } catch { /* Preparation validates early transport facts independently. */ }
          }
          else if (['connecting', 'connected', 'loading', 'decoding', 'metadata'].includes(event.event)) {
            try { onProgress?.(event); } catch { /* A UI progress consumer cannot break process cleanup. */ }
          }
        }
      });
      child.once('close', code => {
        if (expected !== generation) { cancel(); return; }
        if (!hello) finish(spotifyError('unavailable', 'native-incompatible'));
        else if (failure || code !== 0) finish(spotifyError(failure === 'encoded-format-unsupported' ? 'unsupported'
          : ['track-unavailable', 'encoded-track-unavailable'].includes(failure) ? 'not-playable' : 'network', failure || 'native-exited'));
        else if (isAudio(input.action) ? !ready : result === undefined) finish(spotifyError('invalid-response', 'native-no-result'));
        else finish(null, isAudio(input.action) ? ready : result);
      });
    });
  }
  return { request, clear() { generation++; for (const cancel of [...running]) cancel(); } };
}
module.exports = { createNativeHost };
