import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import id from '../../../src/i18n/locales/in';
import zh from '../../../src/i18n/locales/zh-CN';

// test/unit/nativeAudio/locale.test.ts — recovery UI must retain translated fixed codes in every locale.
describe('native audio locale contract', () => {
    it('provides matching settings, recovery actions and fixed error codes', () => {
        for (const locale of [zh, id]) {
            expect(Object.keys(locale.nativeAudio).sort()).toEqual(Object.keys(en.nativeAudio).sort());
            expect(Object.keys(locale.nativeAudio.errors).sort()).toEqual(Object.keys(en.nativeAudio.errors).sort());
            expect(Object.keys(locale.nativeAudio.recovery).sort()).toEqual(Object.keys(en.nativeAudio.recovery).sort());
            for (const message of Object.values(locale.nativeAudio.errors)) expect(message.length).toBeGreaterThan(4);
        }
    });
});
