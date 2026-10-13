// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useNativeAudioRecovery } from '@/hooks/useNativeAudioRecovery';
import { useStatusMessageStore } from '@/stores/useStatusMessageStore';
import type { NativeAudioEvent } from '@/types/nativeAudio';

// A failed Quit restore has no active transport. Only its fixed public category may
// reach the app notice; an old playback session error remains transport-owned.
it('surfaces an unscoped restore failure safely and removes the subscription on cleanup', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let receive: (event: NativeAudioEvent) => void = () => {};
    const unsubscribe = vi.fn();
    Object.assign(window, { electron: { nativeAudio: { onEvent: (handler: typeof receive) => { receive = handler; return unsubscribe; } } } });
    useStatusMessageStore.setState({ message: null });
    function Probe() { const ref = useRef<HTMLAudioElement | null>(null); useNativeAudioRecovery(ref, false); return null; }
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
        await act(async () => root.render(React.createElement(Probe)));
        receive({ event: 'error', session: 'old-session', errorCode: 'SOURCE_RESTORE_UNCONFIRMED', error: 'private response body' });
        expect(useStatusMessageStore.getState().message).toBeNull();
        receive({ event: 'lifecycle-error', errorCode: 'private response body' } as unknown as NativeAudioEvent);
        expect(useStatusMessageStore.getState().message).toBeNull();
        receive({ event: 'lifecycle-error', errorCode: 'SOURCE_RESTORE_UNCONFIRMED' });
        expect(useStatusMessageStore.getState().message).toMatchObject({ type: 'error', persistent: true });
        expect(useStatusMessageStore.getState().message?.text).not.toContain('private response body');
    } finally { await act(async () => root.unmount()); host.remove(); }
    expect(unsubscribe).toHaveBeenCalledOnce();
});
