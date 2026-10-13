// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareOutputHandoff, readOutputHandoffDiagnostics, recordOutputHandoff } from '../../../src/services/nativeAudio/outputHandoff';
import { recordPrivateNativeError } from '../../../src/services/debug/privateDiagnostics';
import { useOutputPlaybackHandoff } from '../../../src/hooks/useOutputPlaybackHandoff';
import type { NativeAudioBackend } from '../../../src/types/nativeAudio';

// test/unit/nativeAudio/privateDiagnosticObservations.test.ts — diagnostics observe settled playback without raw source data.
const state = vi.hoisted(() => ({ audioSrc: 'https://media.invalid/song?secret=PRIVATE_TOKEN', playerState: 'PLAYING' }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({ usePlaybackStore: { getState: () => state }, setPlayerState: (value: string) => { state.playerState = value; } }));
vi.mock('../../../src/stores/useAudioSettingsStore', () => ({ useAudioSettingsStore: { getState: () => ({ volume: .2, isMuted: false }) } }));
vi.mock('../../../src/services/playbackFade', () => ({ playbackFade: { isFadingOut: () => false, cancel: () => {} } }));
vi.mock('../../../src/services/nativeAudio/NativeAudioTransport', () => ({ isNativeAudioElement: () => false, NativeAudioTransport: class {} }));
let root: Root | undefined, host: HTMLDivElement;
const record = vi.fn();
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.assign(window, { electron: { privatePreview: true, privateDiagnostics: { record } } });
    state.playerState = 'PLAYING'; record.mockReset();
});
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; host?.remove(); delete window.electron; vi.restoreAllMocks(); });
const phases = () => record.mock.calls.filter(([value]) => value.event === 'output.handoff').map(([value]) => value.fields.phase);
async function switchOutput(playing = true) {
    state.playerState = playing ? 'PLAYING' : 'PAUSED';
    const previous = document.createElement('audio'), next = document.createElement('audio');
    for (const audio of [previous, next]) audio.setAttribute('src', state.audioSrc);
    previous.currentTime = 37;
    Object.defineProperty(previous, 'paused', { value: !playing });
    let nextPaused = true;
    Object.defineProperty(next, 'paused', { get: () => nextPaused });
    Object.defineProperty(next, 'readyState', { value: 1 });
    Object.defineProperty(next, 'duration', { value: 120 });
    vi.spyOn(previous, 'pause').mockImplementation(() => { state.playerState = 'PAUSED'; });
    let resolve!: () => void, reject!: (error: Error) => void;
    vi.spyOn(next, 'play').mockImplementation(() => new Promise<void>((yes, no) => {
        resolve = () => { nextPaused = false; yes(); }; reject = no;
    }));
    const audioRef = { current: previous }, resume = { current: null as number | null }, autoPlay = { current: false };
    function Probe({ backend }: { backend: NativeAudioBackend }) {
        useOutputPlaybackHandoff(audioRef, backend, backend === 'hqplayer' ? 'PRIVATE_DEVICE_PATH' : '', state.audioSrc, resume, autoPlay); return null;
    }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(React.createElement(Probe, { backend: 'hqplayer' })));
    await act(async () => { prepareOutputHandoff('browser', ''); });
    audioRef.current = next;
    await act(async () => root!.render(React.createElement(Probe, { backend: 'browser' })));
    return { resolve: () => resolve(), reject: (error: Error) => reject(error), audioRef, next };
}
describe('private playback diagnostic observations', () => {
    it('records restored only after play has actually settled, with numeric references and no source identifiers', async () => {
        const f = await switchOutput();
        expect(phases()).toContain('restoring'); expect(phases()).not.toContain('restored');
        await act(async () => f.resolve());
        const events = record.mock.calls.map(([value]) => value);
        const captured = events.find(value => value.fields.phase === 'captured');
        const restored = events.find(value => value.fields.phase === 'restored');
        expect(restored.fields).toMatchObject({ sessionRef: captured.fields.sessionRef, positionSeconds: 37, playing: true, toBackend: 'browser' });
        expect(Number.isSafeInteger(restored.fields.sessionRef)).toBe(true);
        expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|https:|deviceId|source/);
    });
    it('records a completed paused checkpoint without trying to play it', async () => {
        const f = await switchOutput(false);
        expect(f.next.play).not.toHaveBeenCalled();
        expect(record).toHaveBeenCalledWith({ event: 'output.handoff', fields: expect.objectContaining({
            phase: 'restored', positionSeconds: 37, playing: false, toBackend: 'browser',
        }) });
    });
    it.each([false, true])('records the actual rejected settlement (aborted=%s)', async aborted => {
        const f = await switchOutput();
        const error = aborted ? new DOMException('PRIVATE_SECRET', 'AbortError') : Object.assign(new Error('PRIVATE_SECRET_PATH'), { code: 'DEVICE_UNAVAILABLE' });
        await act(async () => f.reject(error));
        expect(phases()).not.toContain('restored');
        expect(record).toHaveBeenCalledWith({ event: 'output.handoff', fields: expect.objectContaining({
            phase: 'restore-failed', reason: aborted ? 'restore-aborted' : 'restore-rejected',
            errorCode: aborted ? 'CANCELLED' : 'DEVICE_UNAVAILABLE', positionSeconds: 37,
        }) });
        expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE_SECRET');
    });
    it('does not label an old play promise as restored after a newer deck owns playback', async () => {
        const f = await switchOutput(); f.audioRef.current = document.createElement('audio');
        await act(async () => f.resolve());
        expect(phases()).not.toContain('restored');
        expect(record).toHaveBeenCalledWith({ event: 'output.handoff', fields: expect.objectContaining({ phase: 'deferred', reason: 'deck-replaced' }) });
    });
    it('omits unknown fields, arbitrary reasons, invalid numeric values and unknown phases before IPC', () => {
        recordOutputHandoff('captured', { backend: 'browser', position: Infinity, playing: true, reason: 'PRIVATE_URL' as any,
            sessionRef: -1, source: state.audioSrc, deviceId: 'PRIVATE_PATH' } as any);
        recordOutputHandoff('PRIVATE_EVENT' as any, {});
        expect(record).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledWith({ event: 'output.handoff', fields: { phase: 'captured', operation: 'output-switch', toBackend: 'browser', playing: true } });
        expect(JSON.stringify(readOutputHandoffDiagnostics())).not.toContain('PRIVATE_');
    });
    it('uses bounded native operation and code fields instead of an exception string', () => {
        recordPrivateNativeError('seek', Object.assign(new Error('PRIVATE_PATH_AND_URL'), { code: 'DECODE_FAILED' }), 7);
        recordPrivateNativeError('PRIVATE_COMMAND', new Error('PRIVATE_URL'), Infinity);
        expect(record.mock.calls.map(([value]) => value)).toEqual([
            { event: 'renderer.native-error', fields: { operation: 'seek', errorCode: 'DECODE_FAILED', sessionRef: 7 } },
            { event: 'renderer.native-error', fields: { operation: 'unknown', errorCode: 'NATIVE_REQUEST_FAILED' } },
        ]);
    });
    it('makes a closed diagnostic bridge harmless to playback observations', () => {
        record.mockImplementationOnce(() => { throw new Error('closed'); });
        expect(() => recordOutputHandoff('requested', { backend: 'asio' })).not.toThrow();
        delete window.electron!.privatePreview;
        recordOutputHandoff('requested', { backend: 'asio' });
        expect(record).toHaveBeenCalledOnce();
    });
});
