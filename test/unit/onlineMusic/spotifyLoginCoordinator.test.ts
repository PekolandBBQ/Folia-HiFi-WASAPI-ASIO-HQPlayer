import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// The shared dialog must survive both authorizations without resurrecting a cancelled session.
const { createLoginCoordinator } = createRequire(import.meta.url)('../../../electron/spotify/loginCoordinator.cjs');
const engine = () => ({ begin: vi.fn(async () => 'child'), check: vi.fn(async () => ({ state: 'confirmed' })),
  cancel: vi.fn(), image: () => 'image', clear: vi.fn() });
describe('Spotify two-step authorization', () => {
  it('starts library authorization only once after playback consent', async () => {
    const device = engine(), catalog = engine(), coordinator = createLoginCoordinator({ device, catalog, vault: { token: async () => null } });
    const key = await coordinator.begin();
    expect(await Promise.all([coordinator.check(key), coordinator.check(key)])).toEqual([{ state: 'waiting' }, { state: 'waiting' }]);
    expect(catalog.begin).toHaveBeenCalledTimes(1); expect(await coordinator.check(key)).toEqual({ state: 'confirmed' });
  });
  it('skips playback consent when its grant already exists', async () => {
    const device = engine(), catalog = engine(), coordinator = createLoginCoordinator({ device, catalog, vault: { token: async () => 'token' } });
    await coordinator.begin(); expect(device.begin).not.toHaveBeenCalled(); expect(catalog.begin).toHaveBeenCalledTimes(1);
  });
  it('cancels a second-step grant that started while the dialog was closing', async () => {
    const device = engine(), catalog = engine(); let resolve!: (key: string) => void;
    catalog.begin.mockImplementation(() => new Promise(r => { resolve = r; }));
    const coordinator = createLoginCoordinator({ device, catalog, vault: { token: async () => null } });
    const key = await coordinator.begin(), checking = coordinator.check(key); await Promise.resolve();
    coordinator.cancel(key); resolve('late-child');
    expect(await checking).toEqual({ state: 'expired' }); expect(catalog.cancel).toHaveBeenCalledWith('late-child');
  });
  it('does not open a browser after logout during preparation cleanup', async () => {
    const device = engine(), catalog = engine(); let finish!: () => void;
    const coordinator = createLoginCoordinator({ device, catalog, vault: { token: async () => null }, onBegin: () => new Promise<void>(r => { finish = r; }) });
    const pending = coordinator.begin(); coordinator.clear(); finish();
    await expect(pending).rejects.toThrow('session-changed'); expect(device.begin).not.toHaveBeenCalled();
  });
});

describe('Spotify catalog-only authorization', () => {
  it.each(['missing', 'expired', 'unreadable'])('does not read or refresh the unused %s playback grant', async state => {
    const device = engine(), catalog = engine();
    const token = vi.fn(async () => { if (state !== 'missing') throw new Error(`legacy-${state}`); return null; });
    const coordinator = createLoginCoordinator({ device, catalog, vault: { token }, deviceRequired: false });
    try {
      const key = await coordinator.begin();
      expect(token).not.toHaveBeenCalled(); expect(device.begin).not.toHaveBeenCalled();
      expect(catalog.begin).toHaveBeenCalledOnce(); expect(coordinator.image(key)).toBe('image');
      expect(await coordinator.check(key)).toEqual({ state: 'confirmed' });
      expect(device.check).not.toHaveBeenCalled();
    } finally { coordinator.clear(); }
  });
  it('cancels the catalog grant and expires its outer key', async () => {
    const device = engine(), catalog = engine();
    const coordinator = createLoginCoordinator({ device, catalog, deviceRequired: false });
    const key = await coordinator.begin(); coordinator.cancel(key);
    expect(catalog.cancel).toHaveBeenCalledWith('child'); expect(device.cancel).not.toHaveBeenCalled();
    expect(coordinator.image(key)).toBe(''); expect(await coordinator.check(key)).toEqual({ state: 'expired' });
    coordinator.clear(); expect(device.clear).toHaveBeenCalledOnce(); expect(catalog.clear).toHaveBeenCalledOnce();
  });
  it('does not begin catalog consent if logout finishes during cleanup', async () => {
    const device = engine(), catalog = engine(); let finish!: () => void;
    const coordinator = createLoginCoordinator({ device, catalog, deviceRequired: false,
      onBegin: () => new Promise<void>(resolve => { finish = resolve; }) });
    const pending = coordinator.begin(); coordinator.clear(); finish();
    await expect(pending).rejects.toThrow('session-changed'); expect(catalog.begin).not.toHaveBeenCalled();
  });
  it('cancels a catalog begin that resolves after logout', async () => {
    const device = engine(), catalog = engine(); let finish!: (key: string) => void;
    catalog.begin.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const coordinator = createLoginCoordinator({ device, catalog, deviceRequired: false });
    const pending = coordinator.begin(); void pending.catch(() => {});
    await vi.waitFor(() => expect(catalog.begin).toHaveBeenCalledOnce());
    coordinator.clear(); finish('late-catalog');
    await expect(pending).rejects.toThrow('session-changed'); expect(catalog.cancel).toHaveBeenCalledWith('late-catalog');
  });
  it('does not return a confirmed catalog result after cancellation', async () => {
    const device = engine(), catalog = engine(); let finish!: (value: { state: string }) => void;
    catalog.check.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const coordinator = createLoginCoordinator({ device, catalog, deviceRequired: false });
    const key = await coordinator.begin(), pending = coordinator.check(key);
    coordinator.cancel(key); finish({ state: 'confirmed' });
    expect(await pending).toEqual({ state: 'expired' });
  });
});
