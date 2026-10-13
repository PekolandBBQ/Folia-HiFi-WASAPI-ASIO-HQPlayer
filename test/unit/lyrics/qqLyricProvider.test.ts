import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import { qrcDecrypt } from '@/utils/lyrics/providers/qrcDecrypt';
import { fetchQQLyrics, searchQQLyrics } from '@/utils/lyrics/providers/qqLyricProvider';

// test/unit/lyrics/qqLyricProvider.test.ts
// Verifies QQ's anonymous lyric request parses the optional romanization track.

vi.mock('@/utils/lyrics/providers/qrcDecrypt', () => ({
    qrcDecrypt: vi.fn(),
}));

const song: SongResult = {
    id: 42,
    name: 'Test song',
    artists: [{ id: 1, name: 'Artist' }],
    album: { id: 1, name: 'Album' },
    durationMs: 60_000,
    qqMid: 'qq-mid',
};

describe('QQ lyric provider', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it('fetches and parses QQ romanization anonymously', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
                code: 0,
                request: { code: 0, data: { lyric: 'orig', trans: 'trans', roma: 'roma', roma_t: 1 } },
            })));
        vi.stubGlobal('fetch', fetchMock);
        vi.mocked(qrcDecrypt).mockImplementation(async value => ({
            orig: '[00:01.00]君のことが好き',
            trans: '[00:01.00]我喜欢你',
            roma: '[00:01.00]Kimi no koto ga suki',
        })[String(value)] || '');

        const lyrics = await fetchQQLyrics(song);

        expect(lyrics?.lines[0]).toMatchObject({
            translation: '我喜欢你',
            romanization: 'Kimi no koto ga suki',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const lyricRequestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        expect(lyricRequestBody.comm).toEqual(expect.objectContaining({ uid: '0' }));
        expect(lyricRequestBody.comm).not.toHaveProperty('sid');
        expect(lyricRequestBody.comm).not.toHaveProperty('userip');
        expect(lyricRequestBody.request.param).toMatchObject({ roma: 1, roma_t: 0 });
    });

    it('keeps QQ lyric searches anonymous', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            code: 0,
            request: { code: 0, data: { body: { item_song: [] } } },
        })));
        vi.stubGlobal('fetch', fetchMock);

        await expect(searchQQLyrics('test')).resolves.toEqual([]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const searchRequestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
        expect(searchRequestBody.request.method).toBe('DoSearchForQQMusicLite');
    });

    it('retains lyric fallback but exposes HTTP errors when catalog search requests it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
        await expect(searchQQLyrics('test')).resolves.toEqual([]);
        await expect(searchQQLyrics('test', 1, 20, { throwOnError: true })).rejects.toThrow('503');
    });

    it('exposes provider errors to catalog search without rejecting a valid empty search', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, request: { code: 1000 } })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, request: { code: 0, data: { body: { item_song: [] } } } })));
        vi.stubGlobal('fetch', fetchMock);
        await expect(searchQQLyrics('test', 1, 20, { throwOnError: true })).rejects.toThrow('1000');
        await expect(searchQQLyrics('test', 1, 20, { throwOnError: true })).resolves.toEqual([]);
    });

    it('normalizes QQ search covers and duration for metadata matching', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            code: 0,
            request: {
                code: 0,
                data: {
                    body: {
                        item_song: [{
                            id: 42,
                            mid: 'song-mid',
                            file: { media_mid: 'different-file-mid' },
                            title: 'Test song',
                            interval: 60,
                            singer: [{ id: 1, name: 'Artist' }],
                            album: { id: 2, mid: 'album-mid', name: 'Album' },
                        }],
                    },
                },
            },
        })));
        vi.stubGlobal('fetch', fetchMock);

        const [result] = await searchQQLyrics('Test song');

        expect(result).toMatchObject({
            durationMs: 60_000,
            sourceRef: { kind: 'online', providerId: 'qq', mediaId: 'song-mid',
                providerData: { songMid: 'song-mid', mediaMid: 'different-file-mid', albumMid: 'album-mid' } },
            album: {
                coverUrl: 'https://y.gtimg.cn/music/photo_new/T002M000album-mid.jpg?max_age=2592000',
            },
        });
    });
});
