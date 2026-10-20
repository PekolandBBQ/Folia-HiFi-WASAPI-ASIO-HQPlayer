import { expect, it } from 'vitest';
import { createRequire } from 'node:module';

// test/unit/nativeAudio/wavHttpRange.test.ts — live byte ranges cannot claim uncaptured data or a completed file.
const { wavHttpRange } = createRequire(import.meta.url)('../../../electron/hqplayer/wavHttpRange.cjs');
it('keeps a live zero-based stream continuous but bounds probe replies to the actual available prefix', () => {
    const live = { available: 44, complete: false, limit: 100000 };
    expect(wavHttpRange('bytes=0-', live)).toMatchObject({ status: 200, start: 0, end: null });
    expect(wavHttpRange('bytes=0-65535', live)).toMatchObject({ status: 206, start: 0, end: 43, contentRange: 'bytes 0-43/*' });
    expect(wavHttpRange('bytes=44-', live)).toMatchObject({ status: 503, reason: 'requested-bytes-not-captured' });
    expect(wavHttpRange('bytes=-32', live)).toMatchObject({ status: 503, reason: 'suffix-awaits-producer-end' });
});
it('reports the final exact range total and rejects malformed or out-of-bounds positions', () => {
    const complete = { available: 844, complete: true, limit: 100000 };
    expect(wavHttpRange('bytes=44-', complete)).toMatchObject({ status: 206, start: 44, end: 843, contentRange: 'bytes 44-843/844' });
    expect(wavHttpRange('bytes=-8', complete)).toMatchObject({ status: 206, start: 836, end: 843 });
    for (const range of ['bytes=844-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,3-4', 'bytes=9007199254740992-', 'bytes=-', 'garbage'])
        expect(wavHttpRange(range, complete).status).toBe(416);
});
