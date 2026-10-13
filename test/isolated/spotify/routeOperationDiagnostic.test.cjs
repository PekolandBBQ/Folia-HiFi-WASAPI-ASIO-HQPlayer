'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = process.env.FOLIA_CANDIDATE_ROOT || path.resolve(__dirname, '../../..');
const { operationFailureDiagnostic } = require(path.join(root, 'electron/spotify/ownedRouteProtocol.cjs'));
const { createOwnedRouteHost } = require(path.join(root, 'electron/spotify/ownedRouteHost.cjs'));
const { installPreviewDiagnosticSink } = require(path.join(root, 'electron/debug/privatePreviewDiagnosticBus.cjs'));

const capabilities = {
  protocolMajor: 1, platform: 'win32-x64', contract: 'folia-owned-route-v1', productionQualified: true, supported: true,
  heldPausedAcquire: true, completeSessionProof: true, notificationCoherent: true, retainedJournalRecovery: true,
  intervalIsolation: true, blockers: [],
  operations: ['hello', 'inspect', 'acquire', 'armCaptureInterval', 'authorizeResume', 'status', 'heartbeat', 'release', 'close'],
};
function fixture(reply) {
  const events = [], commands = [], child = new EventEmitter();
  child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin.write = (line, callback) => {
    const request = JSON.parse(line); commands.push(request.command);
    const response = request.command === 'hello' ? { ok: true, capabilities }
      : request.command === 'close' ? { ok: true, state: 'closed', code: 'NO_POLICY_WRITES', noPolicyWrites: true }
        : reply(request);
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ ...response, id: request.id }) + '\n')); callback?.(); });
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const detach = installPreviewDiagnosticSink({ enabled: () => true, record: (type, fields) => { events.push({ type, fields }); return true; } });
  const host = createOwnedRouteHost({ componentDirectory: '/mock/route', platform: 'win32',
    resolveComponent: async () => '/mock/route.exe', spawnImpl: () => child, timeoutMs: 500, exitTimeoutMs: 100 });
  return { host, commands, events, async dispose() { try { await host.close(); } finally { detach(); } } };
}
const diagnostic = { stage: 'inspect-request', cause: 'worker-eof' };
test('fixed stage and cause pass without expanding route authority', () => {
  assert.deepEqual(operationFailureDiagnostic(diagnostic), diagnostic);
  assert.deepEqual(operationFailureDiagnostic({ stage: 'worker-start', cause: 'unknown' }), { stage: 'worker-start', cause: 'unknown' });
});
for (const [name, value] of [
  ['unknown stage', { ...diagnostic, stage: 'arbitrary' }],
  ['raw cause', { ...diagnostic, cause: 'C:/private/user' }],
  ['extra field', { ...diagnostic, message: 'secret' }],
  ['array', [diagnostic]], ['null', null],
]) test(`reject ${name}`, () => assert.equal(operationFailureDiagnostic(value), undefined));
test('projection never invokes untrusted accessors', () => {
  let reads = 0;
  const value = { cause: 'unknown', get stage() { reads++; throw Error('private'); } };
  assert.equal(operationFailureDiagnostic(value), undefined); assert.equal(reads, 0);
});
test('inspect failure reaches actual diagnostic bus and keeps failure/no-write boundary', async () => {
  const f = fixture(() => ({ ok: false, state: 'closed', code: 'NO_POLICY_WRITES', noPolicyWrites: true,
    failureCode: 'PRODUCT_OPERATION_FAILED', operationFailureDiagnostic: diagnostic }));
  try {
    await assert.rejects(f.host.request('inspect', {}), error => error.code === 'NO_POLICY_WRITES'
      && error.failureCode === 'PRODUCT_OPERATION_FAILED' && error.noPolicyWrites === true && error.restoreReceipt === undefined);
    assert.deepEqual(f.events, [{ type: 'spotify.route-operation-failure', fields: {
      operation: 'inspect', errorCode: 'PRODUCT_OPERATION_FAILED', ...diagnostic,
    } }]);
    assert.deepEqual(f.commands, ['hello', 'inspect']);
  } finally { await f.dispose(); }
});
test('malformed diagnostic is dropped without making failed inspect successful', async () => {
  const f = fixture(() => ({ ok: false, state: 'recoveryRequired', code: 'PRODUCT_OPERATION_FAILED',
    operationFailureDiagnostic: { ...diagnostic, path: 'private' } }));
  try { await assert.rejects(f.host.request('inspect', {}), { code: 'PRODUCT_OPERATION_FAILED' }); assert.deepEqual(f.events, []); }
  finally { await f.dispose(); }
});
test('successful inspection cannot emit failure evidence', async () => {
  const f = fixture(() => ({ ok: true, state: 'idle', operationFailureDiagnostic: diagnostic }));
  try { assert.equal((await f.host.request('inspect', {})).ok, true); assert.deepEqual(f.events, []); }
  finally { await f.dispose(); }
});
test('other commands cannot borrow inspect failure diagnosis', async () => {
  const f = fixture(() => ({ ok: false, state: 'recoveryRequired', code: 'PRODUCT_OPERATION_FAILED', operationFailureDiagnostic: diagnostic }));
  try { await assert.rejects(f.host.request('status', {})); assert.deepEqual(f.events, []); }
  finally { await f.dispose(); }
});
