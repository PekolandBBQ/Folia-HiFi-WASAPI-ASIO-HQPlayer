import { describe, expect, it } from 'vitest';
import { getSpotifyConnectionStep, getSpotifyConnectionView } from '@/services/onlineMusic/spotifyConnectionSteps';
import { automaticCableStatus, cableStatus } from './spotifyCableFixture';
import { EMPTY_CABLE_SELECTION } from '@/services/onlineMusic/spotifyCableSetup';

// The guide distinguishes saved preparation from legacy observed audio readiness.
describe('Spotify cable connection steps', () => {
    it('completes one-time setup without a route probe, a production claim or Windows-default confirmation', () => {
        const status = automaticCableStatus({ selection: { ...cableStatus().selection!, defaultsConfirmed: false } });
        expect(getSpotifyConnectionStep(true, status)).toBe('ready');
        expect(status.automaticRoute?.productionQualified).toBe(false);
        expect(status.probe).toBeUndefined();
        expect(getSpotifyConnectionStep(true, { ...status, coldRecovery: { required: true, recoverable: true, deviceId: 'desktop-1', originalVolume: 42 } })).toBe('cable');
        expect(getSpotifyConnectionStep(true, { ...status, selection: { ...status.selection!, spotifyOnlyConfirmed: false } })).toBe('cable');
        expect(getSpotifyConnectionStep(true, { ...status, selection: { ...status.selection!, internal44100Confirmed: false } })).toBe('cable');
        expect(getSpotifyConnectionStep(true, { ...status, state: 'failed', code: 'ROUTE_RESTORE_UNCONFIRMED' })).toBe('cable');
        expect(getSpotifyConnectionStep(true, { ...status, code: 'BOOTSTRAP_VOLUME_RECOVERY_REQUIRED' })).toBe('cable');
    });
    it('keeps catalog consent independent from audio readiness', () => {
        expect(getSpotifyConnectionStep(false, cableStatus({ state: 'ready' }))).toBe('catalog');
        expect(getSpotifyConnectionStep(true, cableStatus({ spotifyRunning: false }))).toBe('desktop');
        expect(getSpotifyConnectionStep(true, cableStatus({ selection: { ...EMPTY_CABLE_SELECTION } }))).toBe('desktop');
        expect(getSpotifyConnectionStep(true, cableStatus({ state: 'selection-required', code: 'DEVICE_INACTIVE' }))).toBe('desktop');
    });
    it('requires explicit selections, confirmations, and actual format/routing evidence', () => {
        expect(getSpotifyConnectionStep(true, cableStatus({ driverInstalled: false }))).toBe('cable');
        const status = cableStatus();
        expect(getSpotifyConnectionStep(true, { ...status, selection: { ...status.selection!, internal44100Confirmed: false } })).toBe('cable');
        expect(getSpotifyConnectionStep(true, status)).toBe('cable');
        expect(getSpotifyConnectionStep(true, cableStatus({ state: 'ready', probe: undefined }))).toBe('cable');
        expect(getSpotifyConnectionStep(true, cableStatus({ state: 'ready' }))).toBe('ready');
        expect(getSpotifyConnectionStep(true, { hasKey: true, state: 'ready' })).toBe('desktop');
    });
    it.each([{ captureSampleRate: 48000 }, { renderMixSampleRate: 48000 }, { captureMixSampleRate: 48000 },
        { channels: 1 }, { routeVerified: false }, { defaultRenderIsCable: true }, { otherWriterCount: 1 }])('rejects incomplete/mixed format %j', patch => {
        const status = cableStatus({ state: 'ready' });
        expect(getSpotifyConnectionStep(true, { ...status, probe: { ...status.probe!, ...patch } })).toBe('cable');
    });
    it('reviews prior steps without advancing past current verified progress', () => {
        expect(getSpotifyConnectionView('ready', 1)).toEqual({ current: 3, viewed: 1, step: 'desktop', reviewing: true });
        expect(getSpotifyConnectionView('desktop', 4)).toEqual({ current: 1, viewed: 1, step: 'desktop', reviewing: false });
        expect(getSpotifyConnectionView('cable', null).step).toBe('cable');
    });
    it('distinguishes an eligible temporary lease from the current idle format', () => {
        const status = cableStatus({ state: 'ready', code: 'FORMAT_LEASE_ON_PLAY', probe: {
            ...cableStatus().probe!, captureSampleRate: 48000, captureMixSampleRate: 48000, renderMixSampleRate: 48000,
            temporaryFormatLeaseEligible: true, formatLeaseApplied: false } });
        expect(getSpotifyConnectionStep(true, status)).toBe('ready');
        expect(status.probe?.captureSampleRate).toBe(48000);
        expect(getSpotifyConnectionStep(true, { ...status, probe: { ...status.probe!, routeVerified: false } })).toBe('cable');
    });
});
