import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createSpotifyCatalog } = createRequire(import.meta.url)('../../../electron/spotify/catalog.cjs');

// Test requests never contain a real credential or reach Spotify.
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({ ok: status === 200, status, headers: new Headers(headers), json: async () => body });
describe('Spotify catalog transport', () => {
  it('reads Liked Songs from the separate public saved-tracks endpoint with pagination', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ items: [], total: 60, next: null }));
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, fetcher });
    await api.request('savedTracks', { limit: 50, offset: 50 });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.spotify.com/v1/me/tracks?limit=50&offset=50');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the current items endpoint and ten-result search ceiling', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ tracks: { items: [] }, items: [] }));
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, fetcher });
    await api.request('playlistTracks', { id: '0123456789012345678901', limit: 50, offset: 50 });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.spotify.com/v1/playlists/0123456789012345678901/items?limit=50&offset=50');
    await api.request('search', { query: '影色舞', limit: 50 });
    const url = new URL(fetcher.mock.calls[1][0]); expect(url.searchParams.get('limit')).toBe('10'); expect(url.searchParams.get('q')).toBe('影色舞');
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });
  it('honors Retry-After across different requests without retrying early', async () => {
    let now = 0;
    const fetcher = vi.fn().mockResolvedValue(response({}, 429, { 'retry-after': '120' }));
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, fetcher, now: () => now });
    await expect(api.request('playlists')).rejects.toThrow('rate-limited');
    await expect(api.request('search', { query: 'song' })).rejects.toThrow('rate-limited'); expect(fetcher).toHaveBeenCalledTimes(1);
    now = 120001; fetcher.mockResolvedValue(response({ items: [] })); await api.request('playlists'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not leak a raw failure body or turn 403 into an empty library', async () => {
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, fetcher: async () => response({ secret: 'must-not-appear' }, 403) });
    await expect(api.request('playlists')).rejects.toMatchObject({ code: 'unsupported', message: 'Spotify: catalog-http-403' });
  });
  it('distinguishes an explicit quota error and tolerates non-JSON rate-limit bodies', async () => {
    const diagnostic = vi.fn();
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, diagnostic,
      fetcher: async () => response({ error: { reason: 'QUOTA_EXCEEDED', message: 'private-response' } }, 429) });
    await expect(api.request('status')).rejects.toThrow('quota-exceeded');
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: 'quota-exceeded' }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-response');
    const nonJson = createSpotifyCatalog({ vault: { token: async () => 'test-token' },
      fetcher: async () => ({ ...response({}, 429), json: async () => { throw new Error('invalid JSON'); } }) });
    await expect(nonJson.request('status')).rejects.toThrow('rate-limited');
  });
  it('keeps a server cooldown across service restart and serializes simultaneous requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folia-spotify-cooldown-'));
    let now = Date.now();
    const fetcher = vi.fn().mockResolvedValue(response({}, 429, { 'retry-after': new Date(now + 120000).toUTCString() }));
    const options = { directory, vault: { token: async () => 'test-token' }, fetcher, now: () => now };
    try {
      const api = createSpotifyCatalog(options);
      const failures = await Promise.allSettled([api.request('playlists'), api.request('search', { query: 'song' })]);
      expect(failures.every(result => result.status === 'rejected')).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const restarted = createSpotifyCatalog(options);
      await expect(restarted.request('status')).rejects.toMatchObject({ code: 'unavailable', retryAt: expect.any(Number) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += 121000; fetcher.mockResolvedValue(response({ id: 'user' }));
      expect(await restarted.request('status')).toEqual({ id: 'user' });
    } finally { await rm(directory, { force: true, recursive: true }); }
  });
  it('rejects late responses after logout and invalid identifiers before fetching', async () => {
    let finish!: (r: unknown) => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetcher = vi.fn().mockImplementation(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const api = createSpotifyCatalog({ vault: { token: async () => 'test-token' }, fetcher });
    await expect(api.request('song', { id: '../me' })).rejects.toThrow('invalid-id'); expect(fetcher).not.toHaveBeenCalled();
    const pending = api.request('playlists'); const rejected = expect(pending).rejects.toThrow('session-changed');
    await started; api.clear(); finish(response({ items: [] })); await rejected;
  });
});
