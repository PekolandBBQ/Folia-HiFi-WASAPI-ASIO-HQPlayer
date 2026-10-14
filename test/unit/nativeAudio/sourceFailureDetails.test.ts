import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { getNativeErrorCode, nativeErrorKey } from '../../../src/services/nativeAudio/errors';
import zh from '../../../src/i18n/locales/zh-CN';

// Exercise the source-to-native boundary used both by request replies and asynchronous error events.
const { sourceLifecycleError, errorCode } = createRequire(import.meta.url)('../../../electron/nativeAudio/errors.cjs');
it.each(['CABLE_IS_DEFAULT_RENDER', 'SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET', 'STALE_SESSION', 'FORMAT_LEASE_LOCKED'])
('retains %s through native conversion and provides a concrete Chinese message', nativeCode => {
    const source = Object.assign(new Error('private source response'), { code: 'setup-required', nativeCode, stage: 'capture-start' });
    const result = sourceLifecycleError(source);
    expect(errorCode(result)).toBe(nativeCode);
    expect(result).toMatchObject({ nativeCode, stage: 'capture-start', cause: source });
    expect(result.message).not.toContain('private');
    expect(getNativeErrorCode({ code: errorCode(result) })).toBe(nativeCode);
    expect(nativeErrorKey(result)).toBe(`nativeAudio.errors.${nativeCode}`);
    expect(zh.nativeAudio.errors[nativeCode as keyof typeof zh.nativeAudio.errors]).toMatch(/[\u4e00-\u9fff]/);
});
it('preserves unknown diagnostic codes without exposing raw exceptions', () => {
    const result = sourceLifecycleError({ code: 'unavailable', nativeCode: 'NEW_NATIVE_FAILURE', stage: 'scope', message: 'private response' });
    expect(result).toMatchObject({ code: 'SOURCE_UNAVAILABLE', nativeCode: 'NEW_NATIVE_FAILURE', stage: 'scope' });
    expect(result.message).toBe('SOURCE_UNAVAILABLE');
});
