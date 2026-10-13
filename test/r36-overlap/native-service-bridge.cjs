'use strict';
// The real production JS ownedRouteHost parses/authorizes every native callback.
// Only component discovery, OS identity, executable launch and Windows observations are test fixtures.
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const sourceApplication = process.env.FOLIA_SOURCE_TEST_APP || path.resolve(__dirname, '../application');
const { createOwnedRouteHost } = require(path.join(sourceApplication, 'electron/spotify/ownedRouteHost.cjs'));
function createNativeServiceBridge({ getControl, getState, captures, events, hooks, cold = false }) {
  const workspace = '/workspace/scratch/d96e392874a5/folia-rebuild-r34';
  const directory = process.env.FOLIA_NATIVE_FIXTURE_DIRECTORY || path.join(workspace, 'route-lifecycle/native/OwnedRoute.HeldPause.Tests/bin/Debug/net8.0');
  const transcript = [], stderr = [], artifacts = [];
  let child, metrics, inspected = false, ended = false, buffer = '';
  for (const name of ['OwnedRoute.HeldPause.Tests.dll', 'folia-route-service.dll', 'OwnedRoute.Core.dll']) {
    const file = path.join(directory, name), bytes = fs.readFileSync(file);
    artifacts.push({ file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  function observe(chunk) {
    buffer += String(chunk);
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
      const value = JSON.parse(line);
      if (value.event === 'sourceControl') transcript.push({ type: 'source-request', atMs: performance.now(), input: value });
      else { metrics = value._fixtureMetrics; transcript.push({ type: 'native-result', operation: requests.get(value.id)?.command, atMs: performance.now(),
          elapsedMs: performance.now() - requests.get(value.id)?.startedMs, value }); }
    }
  }
  const requests = new Map();
  const host = createOwnedRouteHost({ componentDirectory: directory, platform: 'win32', arch: 'x64', systemRelease: () => '10.0.28000',
    // Explicit fixture injection, never a successful production executable qualification.
    resolveComponent: async () => path.join(directory, 'OwnedRoute.HeldPause.Tests.dll'),
    spawnImpl: () => {
      child = spawn(path.join(workspace, 'toolchains/dotnet/dotnet'), [path.join(directory, 'OwnedRoute.HeldPause.Tests.dll'), '--stdio'],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (data, ...args) => {
        const value = JSON.parse(String(data));
        if (value.command !== 'sourceControlResult') {
          const state = getState();
          value._fixture = { sourcePlaying: state.is_playing, sourceTrackUri: state.item.uri,
            pcmStopped: captures.every(capture => capture.stopped), failRestore: hooks.failRestore === true,
            ...(value.command === 'inspect' && cold && !inspected ? { failColdInspectionOnce: true } : {}) };
          if (value.command === 'inspect') inspected = true;
          requests.set(value.id, { command: value.command, startedMs: performance.now() });
          transcript.push({ type: 'native-send', operation: value.command, id: value.id, atMs: performance.now() }); events.push(`native-csharp:${value.command}`);
        }
        return write(JSON.stringify(value) + '\n', ...args);
      };
      child.stdout.on('data', observe); child.stderr.on('data', chunk => stderr.push(String(chunk)));
      child.on('exit', () => { ended = true; }); return child;
    },
    onSourceControl: async (input, options) => {
      const startedMs = performance.now();
      try { const result = await getControl().routeSourceControl(input, options); transcript.push({ type: 'source-result', atMs: performance.now(), elapsedMs: performance.now() - startedMs, input, result }); return result; }
      catch (error) { transcript.push({ type: 'source-error', input, code: error.code }); throw error; }
    },
  });
  const jsArtifacts = ['cableAudioPreparation', 'desktopPlaybackControl', 'ownedRouteAudio', 'ownedRouteLifecycle', 'ownedRouteHost', 'ownedRouteProtocol'].map(name => {
    const file = path.join(sourceApplication, 'electron/spotify', name + '.cjs'), bytes = fs.readFileSync(file);
    return { file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  return { ...host,
    async request(command, payload) { await hooks.native?.(command, payload); return host.request(command, payload); },
    get metrics() { return metrics; }, transcript, artifacts, jsArtifacts, fixtureQualificationOnly: true,
    async terminateFixture() { if (child && !ended) { child.stdin.end(); await once(child, 'exit'); } },
  };
}
module.exports = { createNativeServiceBridge };
