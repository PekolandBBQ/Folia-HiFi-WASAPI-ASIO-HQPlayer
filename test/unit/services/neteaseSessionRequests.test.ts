import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A local API-address wait must never let an old request borrow a new login cookie.
const key = 'online_provider:netease:cookie';
let values: Map<string, string>;
let releasePort: (port: number) => void;
beforeEach(() => {
    vi.resetModules(); values = new Map([[key, 'old-session']]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    vi.stubGlobal('window', { electron: { getNeteasePort: vi.fn(() => new Promise<number>(resolve => { releasePort = resolve; })) } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: async () => ({ code: 200 }) }));
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('NetEase captured request session', () => {
    it('keeps logout bound to the old login while a new QR login arrives', async () => {
        const { neteaseApi } = await import('@/services/netease');
        const pending = neteaseApi.logout();
        values.set(key, 'new-session'); releasePort(3001); await pending;
        const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
        expect(url.pathname).toBe('/logout'); expect(url.searchParams.get('cookie')).toBe('old-session');
        expect(values.get(key)).toBe('new-session');
    });
    it('uses the supplied typed session for both login and account requests', async () => {
        const { neteaseApi } = await import('@/services/netease');
        const session = { cookie: 'verified-session' };
        const first = neteaseApi.getLoginStatus(session); releasePort(3001); await first;
        values.set(key, 'another-session');
        const second = neteaseApi.getUserAccount(session); releasePort(3002); await second;
        expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get('cookie'))).toEqual(['verified-session', 'verified-session']);
    });
    it('preserves an explicit anonymous session rather than borrowing current login credentials', async () => {
        const { neteaseApi } = await import('@/services/netease');
        const pending = neteaseApi.getLoginStatus({ cookie: null }); releasePort(3001); await pending;
        expect(new URL(String(vi.mocked(fetch).mock.calls[0][0])).searchParams.has('cookie')).toBe(false);
    });
    it('cancels before contacting the API after an address wait', async () => {
        const { neteaseApi } = await import('@/services/netease'); const abort = new AbortController();
        const pending = neteaseApi.getLoginStatus({ cookie: 'old-session', signal: abort.signal });
        abort.abort(); releasePort(3001);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
    });
    it.each([500, 502, 503])('rejects HTTP %s even if its body resembles an expired login', async status => {
        vi.mocked(fetch).mockResolvedValue({ status, json: async () => ({ code: 301 }) } as any);
        const { neteaseApi } = await import('@/services/netease'); const pending = neteaseApi.getLoginStatus(); releasePort(3001);
        await expect(pending).rejects.toMatchObject({ code: 'unavailable' }); expect(values.get(key)).toBe('old-session');
    });
    it.each([401, 403])('reports explicit HTTP %s rejection even without a JSON body', async status => {
        vi.mocked(fetch).mockResolvedValue({ status, json: async () => { throw new SyntaxError('not JSON'); } } as any);
        const { neteaseApi } = await import('@/services/netease'); const pending = neteaseApi.getLoginStatus(); releasePort(3001);
        await expect(pending).rejects.toMatchObject({ code: 'auth-required' });
    });
});
