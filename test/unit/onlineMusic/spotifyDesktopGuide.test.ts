// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SpotifyDesktopSetup from '@/components/app/home/SpotifyDesktopSetup';
import SpotifyConnectionModal from '@/components/app/home/SpotifyConnectionModal';
import type { SpotifyConnection } from '@/hooks/useSpotifyConnection';
import type { DesktopSetupStatus } from '@/components/app/home/spotifyDesktopSetupModel';

// Real Wrapper UI with a synthetic IPC boundary; no installer or backup executes.
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
let host: HTMLDivElement, root: Root, status: DesktopSetupStatus;
const request = vi.fn(), ready = vi.fn(), mode = vi.fn();
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!;
async function mount(modal = false) {
    const connection = { step: 'ready', checking: false, finishing: false, error: null, close: vi.fn(), finishDesktop: ready,
        setup: { status: null, busy: false }, login: { qrState: 'idle' } } as unknown as SpotifyConnection;
    await act(async () => root.render(modal ? React.createElement(SpotifyConnectionModal, { connection, daylight: false })
        : React.createElement(SpotifyDesktopSetup, { onMode: mode, onReady: ready })));
    return connection;
}
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    status = { enabled: true, installations: [{ id: 'desktop', layout: 'desktop', version: 'test' }, { id: 'store', layout: 'store', version: 'test' }],
        selected: 'desktop', detectionFailed: false, running: false, connected: false, cli: true, wrapper: true, extension: true,
        driver: true, driverEndpointsReady: true, engine: true, ready: false, bundleVersion: '0.1.0-preview.2',
        versions: { spicetify: '2.45.3', cable: '3.3.1.7' }, systemOutput: { state: 'ready', names: ['Real DAC'] }, install: { phase: 'installed', busy: false } };
    request.mockReset().mockImplementation(async () => structuredClone(status)); ready.mockReset(); mode.mockReset();
    Object.defineProperty(window, 'electron', { configurable: true, value: { spotify: { request } } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.electron; });
it('checks passively and orders explicit install before configure', async () => {
    await mount(); expect(request.mock.calls.every(([x]) => x.operation === 'status')).toBe(true);
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent);
    expect(labels.indexOf('② 一键配置')).toBe(labels.indexOf('① 一键安装') + 1);
    await act(async () => button('① 一键安装').click()); await act(async () => button('② 一键配置').click());
    expect(request.mock.calls.slice(-2).map(([x]) => x)).toEqual([{ action: 'desktopSetup', operation: 'install' }, { action: 'desktopSetup', operation: 'configure' }]);
    expect(ready).not.toHaveBeenCalled();
});
it('offers desktop and Store versions and sends the chosen installation', async () => {
    await mount(); await act(async () => button('Microsoft Store 版 test').click());
    expect(request).toHaveBeenLastCalledWith({ action: 'desktopSetup', operation: 'choose', installation: 'store' });
});
it('asks the user to install missing Spotify and disables component actions', async () => {
    status.installations = []; status.selected = undefined; await mount();
    expect(document.body.textContent).toContain('请自行安装官网桌面版或 Microsoft Store 版');
    expect(button('① 一键安装').disabled).toBe(true); expect(button('② 一键配置').disabled).toBe(true);
    await act(async () => button('前往 Spotify 下载页').click());
    expect(request).toHaveBeenLastCalledWith({ action: 'desktopSetup', operation: 'open', component: 'spotify' });
});
it('distinguishes failed detection from a missing installation', async () => {
    status.installations = []; status.detectionFailed = true; await mount();
    expect(document.body.textContent).toContain('安装检测失败，尚不能确定是否安装');
});
it.each(['cable', 'unknown'] as const)('keeps system output selection optional for process capture (%s)', async state => {
    status.systemOutput = { state, names: ['CABLE Input'] }; await mount();
    expect(document.body.textContent).toContain('这不是 Spotify 播放的前置步骤');
    expect(button('② 一键配置').disabled).toBe(false);
    await act(async () => button('打开系统声音设置').click());
    expect(request).toHaveBeenLastCalledWith({ action: 'desktopSetup', operation: 'open', component: 'sound' });
    status.systemOutput = { state: 'ready', names: ['Real DAC'] };
    await act(async () => button('重新检查').click()); expect(document.body.textContent).toContain('Windows 默认输出检查通过：Real DAC');
});
it('shows reboot guidance and blocks install/configure until verification', async () => {
    status.install = { phase: 'restart-required', busy: false, restartRequired: true }; await mount();
    expect(document.body.textContent).toContain('请重启 Windows');
    expect(button('① 一键安装').disabled).toBe(true); expect(button('② 一键配置').disabled).toBe(true);
});
it('requires the complete cable pair before configure', async () => {
    status.driverEndpointsReady = false; await mount(); expect(button('② 一键配置').disabled).toBe(true);
});
it('finishes only after readiness and an explicit click', async () => {
    await mount(); expect(button('完成并返回歌单')).toBeUndefined();
    status.ready = true; await act(async () => button('重新检查').click());
    expect(ready).not.toHaveBeenCalled(); await act(async () => button('完成并返回歌单').click()); expect(ready).toHaveBeenCalledOnce();
});
it('retains retry after a failed status request', async () => {
    request.mockRejectedValueOnce(new Error('synthetic')); await mount();
    await act(async () => button('重新检查').click()); expect(document.body.textContent).toContain('准备 Spotify 本机播放');
});
it('portals the current guide, traps focus and restores the trigger on close', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    const connection = await mount(true), dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog.parentElement).toBe(document.body); expect(host.querySelector('[role=dialog]')).toBeNull();
    expect(dialog.querySelector('.spotify-connection-content [aria-label="Spotify 组件安装向导"]')).not.toBeNull();
    const controls = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; controls.at(-1)!.focus();
    await act(async () => controls.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(controls[0]);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(connection.close).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled();
    await act(async () => root.render(null)); expect(document.activeElement).toBe(trigger); trigger.remove();
});
