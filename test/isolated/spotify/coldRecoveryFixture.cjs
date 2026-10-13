'use strict';
// Black-box review against unchanged production modules. All transport is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const application = resolve(process.env.FOLIA_CANDIDATE_ROOT || join(__dirname, '../../..'));
const { createDesktopPlaybackControl } = require(join(application, 'electron/spotify/desktopPlaybackControl.cjs'));
const { createColdVolumeReceipt } = require(join(application, 'electron/spotify/desktopColdRecovery.cjs'));
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp';
const session = '12345678-1234-1234-1234-123456789abc';
const receipt = { version: 1, session, deviceId: 'saved-desktop', trackId, originalVolume: 9 };
const results = [];
async function fixture({ seed = true, initialPaused = true } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'folia-independent-recovery-'));
  const filename = join(directory, 'cold-volume-recovery.json');
  if (seed) await fs.writeFile(filename, JSON.stringify(seed === true ? receipt : seed));
  let clock = 1000, revision = 1, intercept;
  const events = [];
  const device = { id: receipt.deviceId, type: 'Computer', is_active: initialPaused,
    is_restricted: false, supports_volume: true, volume_percent: 9 };
  let state = initialPaused ? { device, item: { uri: `spotify:track:${trackId}`, type: 'track', duration_ms: 120000 },
    currently_playing_type: 'track', is_playing: false, progress_ms: 1500, timestamp: 100, actions: { disallows: {} } } : null;
  const control = createDesktopPlaybackControl({ coldBootstrapDirectory: directory,
    vault: { token: async () => 'synthetic-token', stamp: () => ({ epoch: 1, revision }),
      grantedScopes: async () => ({ epoch: 1, revision, scopes: ['user-read-playback-state', 'user-modify-playback-state'] }) },
    cooldown: { load: async () => 0, defer: async () => 999999 }, now: () => clock,
    wait: async ms => { clock += ms; }, settleTimeoutMs: 100, settleIntervalMs: 10,
    fetcher: async (address, init) => {
      const url = new URL(address), op = url.pathname.split('/').at(-1);
      events.push(`${init.method}:${op}`);
      const response = await intercept?.(op, init, url);
      if (response) return response;
      if (init.method === 'GET') return op === 'devices' ? Response.json({ devices: [device] })
        : state === null ? new Response(null, { status: 204 }) : Response.json(state);
      throw new Error(`Unexpected real-state mutation ${op}`);
    } });
  return { control, directory, filename, device, events, get state() { return state; }, set state(next) { state = next; },
    override: fn => { intercept = fn; }, changeGrant: () => { revision++; },
    check: signal => control.checkColdRecovery({ deviceId: receipt.deviceId, signal }),
    prepare: (extra = {}) => control.prepare({ session, deviceId: receipt.deviceId, trackId, durationMs: 120000,
      restoreSavedTarget: true, beforeSelect: async () => {}, coldBootstrap: async () => {}, ...extra }),
    retained: async () => { try { return JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    close: async () => { await control.dispose(); await fs.rm(directory, { recursive: true, force: true }); } };
}
async function run(name, fn, options) {
  const f = await fixture(options);
  try { const detail = await fn(f); results.push({ name, outcome: 'verified', detail, events: f.events }); }
  finally { await f.close(); }
}
module.exports = { fixture, receipt, application, createColdVolumeReceipt };
