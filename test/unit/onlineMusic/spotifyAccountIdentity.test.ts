import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Independent playback and library grants must never silently cross accounts.
const { createAccountIdentity } = createRequire(import.meta.url)('../../../electron/spotify/accountIdentity.cjs');
describe('Spotify account identity', () => {
  it('coalesces successful identity verification until the session changes', async () => {
    const playbackProfile = vi.fn(async () => ({ id: 'a' })), catalogProfile = vi.fn(async () => ({ id: 'a', product: 'premium' }));
    const identity = createAccountIdentity({ playbackProfile, catalogProfile });
    await Promise.all([identity.ensure(), identity.ensure()]); await identity.ensure();
    expect(playbackProfile).toHaveBeenCalledTimes(1); expect(catalogProfile).toHaveBeenCalledTimes(1);
    identity.clear(); expect(await identity.ensure()).toMatchObject({ product: 'premium' }); expect(playbackProfile).toHaveBeenCalledTimes(2);
  });
  it('rejects mismatched accounts and allows a corrected grant to be checked again', async () => {
    const catalogProfile = vi.fn(async () => ({ id: 'b' }));
    const identity = createAccountIdentity({ playbackProfile: async () => ({ id: 'a' }), catalogProfile });
    await expect(identity.ensure()).rejects.toThrow('account-mismatch');
    catalogProfile.mockResolvedValue({ id: 'a' }); await expect(identity.ensure()).resolves.toMatchObject({ id: 'a' });
  });
  it('rejects verification that finishes after logout', async () => {
    const identity = createAccountIdentity({ playbackProfile: async () => ({ id: 'a' }), catalogProfile: async () => ({ id: 'a' }) });
    const pending = identity.ensure(); identity.clear(); await expect(pending).rejects.toThrow('session-changed');
  });
  it('rechecks successful grants for explicit status and coalesces concurrent checks', async () => {
    const playbackProfile = vi.fn(async () => ({ id: 'a' })), catalogProfile = vi.fn(async () => ({ id: 'a' }));
    const identity = createAccountIdentity({ playbackProfile, catalogProfile });
    await identity.ensure();
    await Promise.all([identity.ensure({ fresh: true }), identity.ensure({ fresh: true }), identity.ensure()]);
    expect(playbackProfile).toHaveBeenCalledTimes(2);
    expect(catalogProfile).toHaveBeenCalledTimes(2);
  });
  it('does not reuse an old success after fresh verification fails', async () => {
    const catalogProfile = vi.fn(async () => ({ id: 'a' }));
    const identity = createAccountIdentity({ playbackProfile: async () => ({ id: 'a' }), catalogProfile });
    await identity.ensure();
    catalogProfile.mockRejectedValue(new Error('authorization revoked'));
    await expect(identity.ensure({ fresh: true })).rejects.toThrow('authorization revoked');
    await expect(identity.ensure()).rejects.toThrow('authorization revoked');
    expect(catalogProfile).toHaveBeenCalledTimes(3);
  });
  it('rejects old verification after clear without discarding a newer in-flight check', async () => {
    let release!: (value: { id: string }) => void;
    const catalogProfile = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ id: 'b' });
    const playbackProfile = vi.fn().mockResolvedValueOnce({ id: 'a' }).mockResolvedValue({ id: 'b' });
    const identity = createAccountIdentity({ playbackProfile, catalogProfile });
    const old = identity.ensure(); identity.clear();
    const current = identity.ensure();
    release({ id: 'a' });
    await expect(old).rejects.toThrow('session-changed');
    await expect(current).resolves.toMatchObject({ id: 'b' });
    await expect(identity.ensure()).resolves.toMatchObject({ id: 'b' });
    expect(catalogProfile).toHaveBeenCalledTimes(2);
  });
});
