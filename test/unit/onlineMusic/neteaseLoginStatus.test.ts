// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { neteaseApi } from '@/services/netease';
import { neteaseProvider } from '@/services/onlineMusic/neteaseProvider';
import { OnlineProviderError } from '@/types/onlineMusic';

// Login verification must distinguish explicit rejection from an unverified response.
vi.mock('@/services/netease', () => ({ isSongMarkedUnavailable: vi.fn(), neteaseApi: { getLoginStatus: vi.fn(), getUserAccount: vi.fn() } }));
const key = 'online_provider:netease:cookie';
const login = () => ({ code: 200, data: { code: 200, profile: { userId: 7, nickname: 'Login' } } });
const account = () => ({ code: 200, account: { id: 7 }, profile: { userId: 7, nickname: 'Account' } });
beforeEach(() => {
    vi.resetAllMocks(); localStorage.clear(); localStorage.setItem(key, 'old-session');
    vi.mocked(neteaseApi.getLoginStatus).mockResolvedValue(login() as any);
    vi.mocked(neteaseApi.getUserAccount).mockResolvedValue(account() as any);
});
describe('NetEase login verification', () => {
    it('verifies both matching identities using the exact same captured session', async () => {
        await expect(neteaseProvider.auth!.getLoginStatus()).resolves.toMatchObject({ id: 7, nickname: 'Account' });
        expect(neteaseApi.getLoginStatus).toHaveBeenCalledWith({ cookie: 'old-session' });
        expect(neteaseApi.getUserAccount).toHaveBeenCalledWith(vi.mocked(neteaseApi.getLoginStatus).mock.calls[0][0]);
    });
    it.each([301, 401, 403])('treats only explicit login code %s as signed out', async code => {
        vi.mocked(neteaseApi.getLoginStatus).mockResolvedValue({ code: 200, data: { code, profile: null } } as any);
        await expect(neteaseProvider.auth!.getLoginStatus()).resolves.toBeNull();
        expect(neteaseApi.getUserAccount).not.toHaveBeenCalled();
    });
    it.each([301, 401, 403])('treats explicit account code %s as signed out', async code => {
        vi.mocked(neteaseApi.getUserAccount).mockResolvedValue({ code, profile: null } as any);
        await expect(neteaseProvider.auth!.getLoginStatus()).resolves.toBeNull();
    });
    it.each([
        { code: 200, data: { code: 200, profile: null } }, { code: 502 },
        { data: { profile: { userId: 7 } } }, { code: 200, data: { code: 503, profile: { userId: 7 } } },
        { code: 'bad', data: { profile: { userId: 7 } } },
        { code: null, data: { code: 200, profile: { userId: 7 } } },
    ])('preserves the session when login response is incomplete or unavailable (%j)', async response => {
        vi.mocked(neteaseApi.getLoginStatus).mockResolvedValue(response as any);
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
        expect(localStorage.getItem(key)).toBe('old-session');
    });
    it.each([
        { code: 200, account: { id: 7 }, profile: null }, { code: 500 },
        { account: { id: 7 }, profile: { userId: 7 } }, { code: 200, account: { id: 7 }, profile: {} },
        { code: 200, account: { id: 8 }, profile: { userId: 8 } },
        { code: 200, account: { id: 7 }, profile: { userId: 8 } },
        { code: 200, account: { id: 0 }, profile: { userId: 7 } },
    ])('refuses incomplete or mismatched account identities (%j)', async response => {
        vi.mocked(neteaseApi.getUserAccount).mockResolvedValue(response as any);
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
        expect(localStorage.getItem(key)).toBe('old-session');
    });
    it('normalizes network failures without treating them as expiry', async () => {
        vi.mocked(neteaseApi.getLoginStatus).mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
    });
    it('retains an explicit transport authentication rejection', async () => {
        vi.mocked(neteaseApi.getLoginStatus).mockRejectedValue(new OnlineProviderError('auth-required', 'Rejected', 'netease'));
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'auth-required' });
    });
    it.each(['login', 'account'])('discards an old %s reply after a new QR session', async stage => {
        const mock = stage === 'login' ? vi.mocked(neteaseApi.getLoginStatus) : vi.mocked(neteaseApi.getUserAccount);
        mock.mockImplementationOnce(async () => { localStorage.setItem(key, 'new-session'); return (stage === 'login' ? { code: 301 } : account()) as any; });
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
        expect(localStorage.getItem(key)).toBe('new-session');
    });
    it('never persists credentials returned by a status check', async () => {
        vi.mocked(neteaseApi.getLoginStatus).mockResolvedValue({ ...login(), cookie: 'stale-reply-cookie' } as any);
        await neteaseProvider.auth!.getLoginStatus();
        expect(localStorage.getItem(key)).toBe('old-session');
    });
    it('does not report stale transport rejection as expiry of a new session', async () => {
        vi.mocked(neteaseApi.getLoginStatus).mockImplementationOnce(async () => {
            localStorage.setItem(key, 'new-session');
            throw new OnlineProviderError('auth-required', 'Old session rejected', 'netease');
        });
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
        expect(localStorage.getItem(key)).toBe('new-session');
    });
});
