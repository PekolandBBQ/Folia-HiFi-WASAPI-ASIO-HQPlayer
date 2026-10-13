import type { Page } from '@playwright/test';

// Mock only the IPC boundary; deferred catalogs reproduce first-open and reconnection timing in real UI.
export async function seedNativeAudioDspMock(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('i18nextLng', 'zh-CN');
        const requests: unknown[] = [];
        const pending: { finish: (rate: number) => void; fail: () => void }[] = [];
        let windowVisible = true;
        const catalog = (rate = 192000) => ({
            state: { mode: 1, filter: 3, shaper: 4, rate: 2, state: 0 }, pending: null,
            modes: [{ index: 1, name: 'PCM', value: 0 }, { index: 2, name: 'SDM (DSD)', value: 1 }],
            catalogs: {
                1: { filters: [{ index: 3, name: 'poly-sinc' }], shapers: [{ index: 4, name: 'TPDF' }], rates: [{ index: 2, rate }] },
                2: { filters: [{ index: 7, name: 'poly-sinc-gauss' }], shapers: [{ index: 8, name: 'ASDM7EC-fast' }], rates: [{ index: 9, rate: 22579200 }] },
            }, deviceControlAvailable: false,
        });
        Object.assign(window, {
            __dspRequests: requests,
            __pendingDspReadCount: () => pending.length,
            __finishDspRead: (index = 0, rate = 192000) => pending.splice(index, 1)[0]?.finish(rate),
            __failDspRead: (index = 0) => pending.splice(index, 1)[0]?.fail(),
            electron: { platform: 'win32', nativeAudio: {
                supported: true, onEvent: () => () => {}, request: async (request: { action: string; visible?: boolean }) => {
                    requests.push(request);
                    if (request.action === 'hqplayer-window') { windowVisible = request.visible ?? windowVisible; return { running: true, visible: windowVisible, controllable: true }; }
                    if (request.action === 'hqplayer-status') return { available: true, needsConfirmation: localStorage.getItem('mock_hqp_existing') === 'true', instancePid: 77 };
                    if (request.action === 'hqplayer-dsp-read') {
                        if (localStorage.getItem('mock_hqp_deferred_read') === 'true') return new Promise((resolve, reject) => {
                            pending.push({ finish: rate => resolve(catalog(rate)), fail: () => reject(Object.assign(new Error('Unavailable'), { code: 'HQPLAYER_UNAVAILABLE' })) });
                        });
                        return catalog();
                    }
                    return { ok: true };
                },
            } },
        });
    });
}
