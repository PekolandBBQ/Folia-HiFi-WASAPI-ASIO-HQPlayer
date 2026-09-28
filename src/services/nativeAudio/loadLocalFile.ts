import type { NativeAudioApi, NativeAudioBackend, NativeAudioProcessingMode, NativeAudioState } from '../../types/nativeAudio';

// src/services/nativeAudio/loadLocalFile.ts — stage a library File or an already-resolved cache blob in bounded chunks.
export async function loadNativeLocalFile(api: NativeAudioApi, session: string, file: File,
    backend: NativeAudioBackend, deviceId: string, signal: AbortSignal, processingMode: NativeAudioProcessingMode = 'compatibility', hqplayerGainDb = -2): Promise<NativeAudioState> {
    signal.throwIfAborted();
    const path = window.electron?.webUtils?.getPathForFile(file) || '';
    await api.request({ action: 'begin', session, backend, deviceId, processingMode, hqplayerGainDb, sourceName: file.name, mimeType: file.type, ...(path ? { path } : {}) });
    signal.throwIfAborted();
    if (!path) {
        // File System Access handles do not always expose an OS path. Bounded chunks keep a
        // large local file out of a single IPC allocation and allow cancellation between writes.
        for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
            signal.throwIfAborted();
            const data = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer());
            signal.throwIfAborted();
            await api.request({ action: 'chunk', session, data });
        }
    }
    signal.throwIfAborted();
    const result = await api.request({ action: 'finish', session }) as NativeAudioState;
    signal.throwIfAborted();
    return result;
}
