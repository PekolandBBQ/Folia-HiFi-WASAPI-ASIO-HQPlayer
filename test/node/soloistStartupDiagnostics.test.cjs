const assert = require('node:assert/strict');
const { test } = require('node:test');
const { soloistStartupDiagnosticsCommand, validateSoloistStartupDiagnostics } = require('../../electron/spotify/soloistStartupDiagnostics.cjs');

// Diagnostic fixtures contain only safe state enums; no service is queried.
const ids = ['folia-credentials-ready.path', 'folia-runtime.target', 'folia-music-assistant.service',
  'folia-sendspin-bootstrap.service', 'folia-sendspin.service', 'folia-spotify-bootstrap.service', 'folia-pairing-relay.service'];
const sample = () => ({ schema: 1, units: ids.map(unit => ({ unit, available: true, loadState: 'loaded', activeState: 'active',
  subState: unit.endsWith('.path') ? 'waiting' : unit.endsWith('.target') ? 'active' : 'running', result: 'success',
  exitCode: 0, termination: 'none', hasMainProcess: unit.endsWith('.service'), restarts: 0, conditionPassed: true, assertPassed: true })) });
test('startup diagnostic is a fixed main command restricted to read-only known unit properties', () => {
  assert.match(soloistStartupDiagnosticsCommand, /^\/usr\/bin\/python3 -I -c '/);
  const source = Buffer.from(/base64\.b64decode\("([A-Za-z0-9+/=]+)"\)/.exec(soloistStartupDiagnosticsCommand)[1], 'base64').toString();
  assert.match(source, /\['\/usr\/bin\/systemctl','show','--no-pager','--property='/);
  assert.equal(/journalctl|\/proc|cmdline|argv\[|password|soloist-key|settings\.json|\.read_text\(|\.read_bytes\(|shell=True/.test(source), false);
  assert.match(source, /stderr=subprocess.DEVNULL,timeout=2/); assert.match(source, /len\(raw\)>4096/);
  for (const id of ids) assert.equal(source.includes(id), true);
});
test('startup projection is frozen and distinguishes a crashing MA from pending dependent services', () => {
  const input = sample(); input.units[2] = { ...input.units[2], activeState: 'activating', subState: 'auto-restart',
    result: 'exit-code', termination: 'exited', exitCode: 1, hasMainProcess: false, restarts: 23 };
  input.units[3] = { ...input.units[3], activeState: 'inactive', subState: 'dead', hasMainProcess: false };
  const value = validateSoloistStartupDiagnostics(input);
  assert.equal(value.units[2].exitCode, 1); assert.equal(value.units[2].restarts, 23); assert.equal(value.units[3].activeState, 'inactive');
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.units), true); assert.equal(Object.isFrozen(value.units[2]), true);
  input.units[2].exitCode = 100; assert.equal(value.units[2].exitCode, 1);
});
test('unknown and unavailable observations remain unknown instead of implying startup success', () => {
  const input = sample(); input.units[2] = { unit: ids[2], available: false, loadState: 'unknown', activeState: 'unknown', subState: 'unknown',
    result: 'unknown', exitCode: null, termination: 'unknown', hasMainProcess: false, restarts: null, conditionPassed: null, assertPassed: null };
  const value = validateSoloistStartupDiagnostics(input);
  assert.equal(value.units[2].available, false); assert.equal(value.units[2].hasMainProcess, false); assert.equal(value.units[2].exitCode, null);
});
test('startup reports reject raw output, private fields, foreign units, missing observations and reordered units', () => {
  for (const change of [value => { value.raw = 'SECRET argv account'; }, value => { value.units[2].journal = 'SECRET'; },
    value => { value.units[2].unit = 'foreign.service'; }, value => { value.units.pop(); }, value => { value.units.reverse(); },
    value => { value.units[2].activeState = 'SECRET'; }, value => { value.units[2].subState = 'SECRET'; },
    value => { value.units[2].result = 'SECRET'; }, value => { value.units[2].loadState = 'SECRET'; },
    value => { value.units[2].termination = 'SECRET'; }]) {
    const value = sample(); change(value);
    assert.throws(() => validateSoloistStartupDiagnostics(value), error => error.code === 'GUEST_PROTOCOL_INVALID' && !error.message.includes('SECRET'));
  }
});
test('numeric exit/status counts and nullable booleans have strict noncoercing bounds', () => {
  for (const [field, item] of [['exitCode', '1'], ['exitCode', -1], ['exitCode', 1.2], ['exitCode', NaN],
    ['restarts', 100000001], ['available', null], ['hasMainProcess', 1], ['conditionPassed', 'yes'], ['assertPassed', 0]]) {
    const value = sample(); value.units[2][field] = item; assert.throws(() => validateSoloistStartupDiagnostics(value), { code: 'GUEST_PROTOCOL_INVALID' });
  }
});
test('startup projection cannot be invoked from a renderer', () => {
  const previous = process.type;
  try { process.type = 'renderer'; assert.throws(() => validateSoloistStartupDiagnostics(sample()), { code: 'GUEST_PROTOCOL_INVALID' }); }
  finally { if (previous === undefined) delete process.type; else process.type = previous; }
});
