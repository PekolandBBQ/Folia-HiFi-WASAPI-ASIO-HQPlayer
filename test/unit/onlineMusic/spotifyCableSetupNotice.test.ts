import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { cableStatus } from './spotifyCableFixture';
import en from '@/i18n/locales/en';
import zh from '@/i18n/locales/zh-CN';
import id from '@/i18n/locales/in';

// test/unit/onlineMusic/spotifyCableSetupNotice.test.ts: both setup surfaces use the same read-only explanation.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/modal/settings/SpotifyCableFields', () => ({ default: () => null }));
vi.mock('@/services/onlineMusic/spotifyPlaybackSetup', () => ({ spotifyPlaybackSetup: {} }));
import SpotifyCableSetupNotice from '@/components/modal/settings/SpotifyCableSetupNotice';
import SpotifyConnectionSteps from '@/components/app/home/SpotifyConnectionSteps';

describe('VB-CABLE setup notices', () => {
    it.each([
        ['CABLE_IS_DEFAULT_RENDER', 'routeDefault'], ['CABLE_SHARED_WITH_OTHER_AUDIO', 'routeShared'],
        ['FOLIA_FEEDBACK_ROUTE', 'routeFeedback'], ['SPOTIFY_ROUTE_NOT_FOUND', 'routeMissing'],
        ['ROUTE_OBSERVATION_FAILED', 'routeUnverified'], ['ROUTE_IDENTITY_UNAVAILABLE', 'routeUnverified'],
        ['ROUTE_PROBE_FAILED', 'routeProbeFailed'], ['SOURCE_DEFAULT_POLICY_REQUIRED', 'sourceDefaultRequired'],
        ['ROUTE_SOURCE_DEFAULT_REQUIRED', 'sourceDefaultRequired'], ['BOOTSTRAP_VOLUME_UNAVAILABLE', 'bootstrapUnavailable'],
        ['BOOTSTRAP_VOLUME_UNCONFIRMED', 'bootstrapUnavailable'], ['BOOTSTRAP_VOLUME_RECOVERY_REQUIRED', 'bootstrapRecovery'],
        ['BOOTSTRAP_IDENTITY_UNCONFIRMED', 'bootstrapIdentity'],
        ['PLAYBACK_STATE_UNCONFIRMED', 'sourceControlUnconfirmed'], ['SOURCE_RESTORE_UNCONFIRMED', 'sourceRestoreUnconfirmed'],
    ])('explains %s as a routing issue without fabricating capture or driver failure', (code, key) => {
        const markup = renderToStaticMarkup(React.createElement(SpotifyCableSetupNotice, { status: cableStatus({
            state: 'routing-required', code, selection: { ...cableStatus().selection!, internal44100Confirmed: false },
        }) }));
        expect(markup).toContain(`spotifyCable.${key}`); expect(markup).toContain(code);
        expect(markup).not.toContain('confirmationRequired'); expect(markup).not.toContain('checkFailed');
        expect(markup).not.toContain('driver-missing'); expect(markup).not.toContain('CAPTURE_REQUEST_FAILED');
    });
    it('keeps unknown failures generic and lease success informational', () => {
        const render = (code?: string) => renderToStaticMarkup(React.createElement(SpotifyCableSetupNotice, { status: cableStatus({ code }) }));
        expect(render('UNRECOGNIZED_CODE')).toContain('spotifyCable.checkFailed');
        expect(render('FORMAT_LEASE_PROBE_RELEASED')).toContain('spotifyCable.probeReleased');
        expect(render('FORMAT_LEASE_PROBE_RELEASED')).not.toContain('checkFailed');
        expect(render('FORMAT_LEASE_ON_PLAY')).toBe(''); expect(render()).toBe('');
    });
    it('shows all missing confirmations when a confirmation-required response has no saved selection', () => {
        const markup = renderToStaticMarkup(React.createElement(SpotifyCableSetupNotice, { status: cableStatus({
            state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED', selection: undefined,
        }) }));
        expect(markup).toContain('pendingInternalRate'); expect(markup).toContain('pendingSpotifyOnly');
        expect(markup).not.toContain('pendingDefaults');
    });
    it('uses the same notice in the wizard while review stays read-only and hides current status', () => {
        const status = cableStatus({ state: 'routing-required', code: 'CABLE_CONFIRMATION_REQUIRED',
            selection: { ...cableStatus().selection!, internal44100Confirmed: false } });
        const connection = { setup: { status }, login: { qrState: 'idle' } } as any;
        const render = (reviewing: boolean) => renderToStaticMarkup(React.createElement(SpotifyConnectionSteps, { connection, step: 'cable', reviewing }));
        expect(render(false)).toContain('spotifyCable.confirmationRequired');
        expect(render(false)).toContain('spotifyCable.pendingInternalRate');
        expect(render(false)).not.toContain('spotifyCable.checkFailed');
        expect(render(true)).not.toContain('spotify-cable-setup-notice');
        expect(status.selection!.internal44100Confirmed).toBe(false);
    });
    it('does not ask for Windows per-app Default or expose retired routing modes in setup copy', () => {
        expect(en.spotifyCable.clientOutputStep).toContain('In the Spotify desktop client');
        expect(zh.spotifyCable.clientOutputStep).toContain('Spotify 桌面客户端');
        expect(en.spotifyCable.exclusiveHint).toContain('If the option is absent');
        expect(en.spotifyCable.sourceDefaultRequired).toContain('safe explicit output choices can be preserved');
        expect(en.spotifyCable.sourceDefaultRequired).not.toContain('choose Default');
        expect(en.spotifyCable.volumeHistoryRetained).toContain('does not block playback');
        expect(en.spotifyCable.coldRecoveryCheckHint).toContain('twice');
        expect(en.spotifyCable.volumeHistoryRetained).toContain('no longer changes or checks Spotify volume');
        for (const locale of [en, zh, id]) {
            expect(locale.spotifyCable).not.toHaveProperty('automaticTrialOptIn');
            expect(locale.spotifyCable).not.toHaveProperty('manualRouteHint');
            expect(locale.spotifyCable.spotifyOnlyConfirmed).not.toContain('Windows');
        }
    });
    it('supplies every explanation in all shipped cable locales with an explicit internal-rate limitation', () => {
        const keys = ['confirmationRequired', 'pendingInternalRate', 'pendingSpotifyOnly', 'clientConfirmationRequired', 'internalConfirmationRequired',
            'clientSetupTitle', 'clientOutputStep', 'clientSetupSavedHint', 'bootstrapUnavailable', 'bootstrapRecovery', 'bootstrapIdentity',
            'recoveryDesktop', 'recoveryVolume', 'coldRecoverySteps', 'coldRecoveryUnavailable', 'checkColdRecovery',
            'coldRecoveryChecking', 'coldRecoveryCheckHint', 'coldRecoveryUnconfirmed', 'volumeHistoryRetained', 'sourceControlUnconfirmed', 'sourceRestoreUnconfirmed',
            'routeDefault', 'routeShared', 'routeFeedback', 'routeMissing', 'routeUnverified', 'routeProbeFailed', 'internalHint'];
        for (const locale of [en, zh, id]) for (const key of keys)
            expect((locale.spotifyCable as Record<string, unknown>)[key]).toEqual(expect.any(String));
        expect(en.spotifyCable.internalHint).toContain('successful capture do not verify this internal setting');
        expect(zh.spotifyCable.internalHint).toContain('保持此确认未勾选');
        expect(id.spotifyCable.internalHint).toContain('jangan centang');
    });
});


it.each([false, true])('shows historical receipt without offering volume recovery (uncertain source: %s)', sourceControlUnconfirmed => {
    const markup = renderToStaticMarkup(React.createElement(SpotifyCableSetupNotice, { status: cableStatus({
        code: undefined, coldRecovery: { required: false, recoverable: false, archived: true,
            unresolvedHistorical: true, sourceControlUnconfirmed, deviceId: 'desktop-1', originalVolume: 9 },
    }) }));
    expect(markup).toContain('spotify-cold-history');
    expect(markup).toContain('spotifyCable.volumeHistoryRetained');
    expect(markup.includes('spotifyCable.sourceControlUnconfirmed')).toBe(sourceControlUnconfirmed);
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('spotifyCable.recoveryVolume');
    expect(markup).not.toContain('spotifyCable.checkColdRecovery');
});
