import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Real API/private-installer/sidecar integration, with synthetic HTTP and a disposable private profile only.
const require = createRequire(import.meta.url);
const { createDesktopPlaybackApi } = require('../../../electron/spotify/desktopPlaybackApi.cjs');
const { installPrivatePreviewDiagnostics, IPC_CHANNEL } = require('../../../electron/debug/privatePreviewDiagnostics.cjs');
const { installPauseResponseInspection, inspectRejectedPauseResponse, DIRECTORY, MAX_REPORT_BYTES } = require('../../../electron/debug/pauseResponseInspection.cjs');
const { projectEvent } = require('../../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const { pauseResponseFields } = require('../../../electron/spotify/requestDiagnostics.cjs');
const { unzipSync } = require('fflate');
const cleanups: Array<() => void> = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
const rejectedBody = '{"error":"Synthetic playback failed."}';
afterEach(() => { for (const cleanup of cleanups.reverse().splice(0)) cleanup(); vi.restoreAllMocks(); });

function fixture({ flag = '1', timeoutMs = 4000, ownsLock = true, beforeReady = (_profile: string) => {} } = {}) {
  const profile = fs.mkdtempSync(path.join(tmpdir(), 'folia-pause-inspection-'));
  cleanups.push(() => fs.rmSync(profile, { recursive: true, force: true }));
  const processObject = Object.assign(new EventEmitter(), { env: { FOLIA_PRIVATE_PAUSE_RESPONSE_INSPECTION: flag } });
  const app = Object.assign(new EventEmitter(), { hasSingleInstanceLock: () => ownsLock, isPackaged: false });
  const exported = path.join(profile, 'ordinary-diagnostics.zip');
  const handlers = new Map(), frame = { url: 'file:///synthetic/index.html' };
  const sender = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const diagnostics = installPrivatePreviewDiagnostics({ app, profile, processObject,
    ipcMain: { handle: (name: string, handler: unknown) => handlers.set(name, handler), removeHandler: vi.fn() }, shell: {},
    dialog: { showSaveDialog: async () => ({ filePath: exported, canceled: false }) }, rendererEntry: 'file:///synthetic/index.html' });
  cleanups.push(() => diagnostics.close());
  beforeReady(profile); app.emit('ready');
  let revision = 0;
  const vault = { token: async () => 'SYNTHETIC_PRIVATE_TOKEN', stamp: () => ({ epoch: 0, revision }), grantedScopes: async () => ({}) };
  const fetcher = vi.fn(async () => new Response(rejectedBody));
  const record = { deviceId: 'SYNTHETIC_PRIVATE_DEVICE', trackId: '3n3Ppam7vgaVa1iaRUc9Lp', stamp: vault.stamp(),
    controller: new AbortController(), mutationPending: false };
  const current = () => { if (record.controller.signal.aborted) throw Object.assign(new Error('STALE_SESSION'), { code: 'STALE_SESSION' }); };
  const api = createDesktopPlaybackApi({ vault, cooldown: { load: async () => 0, defer: async () => 0 }, fetcher, timeoutMs });
  const directory = path.join(profile, DIRECTORY);
  const files = () => fs.existsSync(directory) ? fs.readdirSync(directory).map(name => path.join(directory, name)) : [];
  return { profile, directory, diagnostics, exported, fetcher, record, files, changeGrant: () => { revision++; },
    arm: () => handlers.get(IPC_CHANNEL)({ sender, senderFrame: frame }, { action: 'armPauseResponseInspection' }),
    request: (operation = 'pause', signal?: AbortSignal) => api.request(operation, record, current, { signal }),
    reports: () => files().map(file => JSON.parse(fs.readFileSync(file, 'utf8'))) };
}

it('captures one rejected response in the private sidecar and excludes it from the actual ordinary ZIP', async () => {
  const f = fixture();
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(f.files()).toHaveLength(1);
  expect(path.basename(f.files()[0])).toMatch(/^pause-[a-f0-9-]{36}\.json$/);
  expect(fs.statSync(f.files()[0]).size).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  expect(f.reports()[0]).toMatchObject({ httpStatus: 200, utf8Valid: true, ascii: true,
    filter: 'blocked-unrecognized' });
  expect(Object.hasOwn(f.reports()[0], 'localCandidate')).toBe(false);
  expect(Buffer.from(f.reports()[0].bodyBase64, 'base64').toString()).toBe(rejectedBody);
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(f.files()).toHaveLength(1); expect(f.record.mutationPending).toBe(true); expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(await f.diagnostics.export()).toEqual({ ok: true });
  const zip = unzipSync(fs.readFileSync(f.exported));
  expect(Object.keys(zip).sort()).toEqual(['build-info.json', 'diagnostics.jsonl', 'export-info.json']);
  const normal = Object.values(zip).map((bytes: any) => Buffer.from(bytes).toString()).join('\n');
  expect(normal).not.toMatch(/Synthetic playback failed|localCandidate|bodyBase64|private-pause-inspection|SYNTHETIC_PRIVATE/);
});

it.each([
  ['abcdefghijklmnopqrstuvwxyzA', 'blocked-sensitive-marker', true, false],
  ['Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9', 'blocked-sensitive-marker', true, false],
  ['Error for person@example.com', 'blocked-sensitive-marker', true, false],
  ['Error at https://example.com', 'blocked-sensitive-marker', true, false],
  ['Error: token syntheticsecret', 'blocked-sensitive-marker', true, false],
  ['Unknown synthetic sentence', 'blocked-unrecognized', true, false],
  ['Error: playback failed.', 'local-review-required', true, false],
  ['\uFEFF{}', 'quarantined-nontext', true, true],
  ['Error\u0000', 'quarantined-nontext', true, false],
  [new Uint8Array([0xff, 0xc0, 0xaf]), 'quarantined-nontext', false, false],
])('preserves standalone quarantine filtering for synthetic rejected bytes case %#', async (body, filter, utf8Valid, hasBom) => {
  const f = fixture();
  expect(inspectRejectedPauseResponse(Buffer.from(body))).toBe(true); await tick();
  const [report] = f.reports();
  expect(report).toMatchObject({ filter, utf8Valid, hasBom });
  expect(Buffer.from(report.bodyBase64, 'base64')).toEqual(typeof body === 'string' ? Buffer.from(body) : Buffer.from(body));
  expect(Object.hasOwn(report, 'localCandidate')).toBe(filter === 'local-review-required');
  expect(JSON.stringify(report)).not.toContain('SYNTHETIC_PRIVATE_TOKEN');
});

it.each(['The command was successful.', 'abcdefghijklmnopqrstuvwxyzA', 'Error for person@example.com', 'Error: token syntheticsecret'])('does not capture opaque text when only later state observations can confirm it: %s', async body => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(body));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' }); await tick();
  expect(f.files()).toEqual([]); expect(f.diagnostics.status().pauseResponseInspection).toBe('armed');
});

it.each(['', '0', 'true'])('stays inert when the explicit one-run flag is %j', async flag => {
  const f = fixture({ flag });
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(fs.existsSync(f.directory)).toBe(false);
});

it('does not arm without the private main-instance lock, or collect after installer close', async () => {
  const unowned = fixture({ ownsLock: false });
  await expect(unowned.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(unowned.files()).toEqual([]); unowned.diagnostics.close();
  const closed = fixture(); closed.diagnostics.close();
  await expect(closed.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(closed.files()).toEqual([]);
});

it('ignores inert acknowledgments, other endpoints/statuses and bodies above the independent 128-byte limit', async () => {
  const f = fixture();
  for (const body of ['', ' \t\r\n', 'null', '{}']) {
    f.fetcher.mockResolvedValue(new Response(body)); await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  }
  f.fetcher.mockResolvedValue(new Response('Error: playback failed.', { status: 403 }));
  await expect(f.request()).rejects.toMatchObject({ code: 'API_FORBIDDEN' });
  f.fetcher.mockResolvedValue(new Response('Error: playback failed.'));
  await expect(f.request('play')).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  f.fetcher.mockResolvedValue(new Response('A'.repeat(129)));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' });
  f.fetcher.mockResolvedValue(new Response('A'.repeat(4097)));
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  await tick(); expect(f.files()).toEqual([]);
});

it.each(['caller', 'lease', 'grant'])('never captures a fully drained late response after %s invalidation', async source => {
  const f = fixture(), abort = new AbortController(); let pulls = 0;
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
    if (++pulls === 1) { controller.enqueue(Buffer.from('The command was successful.')); return; }
    if (source === 'caller') abort.abort(); else if (source === 'lease') f.record.controller.abort(); else f.changeGrant();
    controller.close();
  } })));
  await expect(f.request('pause', abort.signal)).rejects.toMatchObject({ code:
    source === 'caller' ? 'CANCELLED' : source === 'lease' ? 'STALE_SESSION' : 'SESSION_CHANGED' });
  await tick(); expect(f.files()).toEqual([]);
});

it('does not capture a truncated or stalled body and keeps the original timeout bound', async () => {
  const f = fixture({ timeoutMs: 5 });
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from('Error: playback failed.')); controller.error(new Error('SYNTHETIC_PRIVATE_TRANSPORT'));
  } })));
  await expect(f.request()).rejects.toThrow('SYNTHETIC_PRIVATE_TRANSPORT');
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('Error')); } })));
  await expect(f.request()).rejects.toMatchObject({ name: 'TimeoutError' });
  await tick(); expect(f.files()).toEqual([]);
});

it('refuses a redirecting destination and swallows write failures without altering the request failure', async () => {
  const f = fixture({ beforeReady: profile => fs.symlinkSync(profile, path.join(profile, DIRECTORY), 'dir') });
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(fs.readdirSync(f.profile).filter(name => /^pause-/.test(name))).toEqual([]);
  f.diagnostics.close();
  const writeFailure = fixture({ flag: '' }), openSync = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE_PATH'); });
  const close = installPauseResponseInspection({ profile: writeFailure.profile, armed: true, enabled: () => true, fsImpl: { ...fs, openSync } });
  cleanups.push(close);
  await expect(writeFailure.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  await expect(writeFailure.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(openSync).toHaveBeenCalledOnce(); expect(writeFailure.files()).toEqual([]);
});

it('projects only finite response header categories and never lets a throwing header reader mask playback', () => {
  expect(pauseResponseFields({ headers: new Headers({ 'content-type': 'application/problem+json; private=SYNTHETIC_PRIVATE', 'content-encoding': 'gzip' }) }))
    .toEqual({ contentType: 'json', contentEncoding: 'gzip' });
  expect(pauseResponseFields({ get headers() { throw new Error('SYNTHETIC_PRIVATE_HEADER'); } }))
    .toEqual({ contentType: 'other', contentEncoding: 'other' });
  const base = { endpoint: 'playback-pause', method: 'PUT', httpStatus: 200, phase: 'failed' };
  expect(projectEvent('spotify.playback-control', { ...base, contentType: 'SYNTHETIC_PRIVATE_TYPE', contentEncoding: 'SYNTHETIC_PRIVATE_ENCODING',
    localCandidate: 'SYNTHETIC_PRIVATE_BODY', bodyBase64: 'SYNTHETIC_PRIVATE_BYTES', body: 'SYNTHETIC_PRIVATE_BODY' }))
    .toEqual({ type: 'spotify.playback-control', fields: base });
});

it('GUI arming captures the real strict API rejection without an environment flag and never changes its verdict', async () => {
  const f = fixture({ flag: '' });
  expect(f.diagnostics.status().pauseResponseInspection).toBe('idle');
  expect(await f.arm()).toEqual({ ok: true, pauseResponseInspection: 'armed' });
  f.fetcher.mockResolvedValue(new Response('A'.repeat(129)));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' }); await tick();
  expect(f.diagnostics.status().pauseResponseInspection).toBe('armed'); expect(f.files()).toEqual([]);
  f.fetcher.mockResolvedValue(new Response('The command was successful.'));
  await expect(f.request()).resolves.toEqual({ acknowledgment: 'UNCONFIRMED' }); await tick();
  expect(f.diagnostics.status().pauseResponseInspection).toBe('armed'); expect(f.files()).toEqual([]);
  f.fetcher.mockResolvedValue(new Response(rejectedBody));
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(f.diagnostics.status().pauseResponseInspection).toBe('captured');
  expect(Buffer.from(f.reports()[0].bodyBase64, 'base64').toString()).toBe(rejectedBody);
  expect(f.record.mutationPending).toBe(true);
  expect(await f.arm()).toEqual({ ok: true, pauseResponseInspection: 'captured' });
  f.fetcher.mockResolvedValue(new Response(rejectedBody));
  await expect(f.request()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' }); await tick();
  expect(f.files()).toHaveLength(1);
});


it.each(['seek', 'select', 'play', 'transfer'])('never sends a rejected %s 200 body into the legacy pause inspector', async operation => {
  const f = fixture(); f.fetcher.mockResolvedValue(new Response(rejectedBody));
  await expect(f.request(operation)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  await tick(); expect(f.files()).toEqual([]);
  f.fetcher.mockResolvedValue(new Response(new Uint8Array([0xff])));
  await expect(f.request(operation)).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
  await tick(); expect(f.files()).toEqual([]);
});
