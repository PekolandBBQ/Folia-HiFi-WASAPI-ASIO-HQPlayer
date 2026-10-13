import { useCallback, useEffect, useRef } from 'react';
import { readProviderSessionValue } from '../services/onlineMusic/providerStorage';

// NetEase request lifetimes and ordered cache mutations, including across hook remounts.
let cacheWrites: Promise<unknown> = Promise.resolve();
export const enqueueNeteaseCacheWrite = <T>(run: () => Promise<T>): Promise<T> => {
    const task = cacheWrites.catch(() => {}).then(run);
    cacheWrites = task;
    return task;
};
export const waitForNeteaseCacheWrites = (): Promise<unknown> => cacheWrites.catch(() => {});
export const readNeteaseSession = (): string | null => readProviderSessionValue('netease', 'cookie', ['netease_cookie']);
export type NeteaseRequestFence = { current: () => boolean; active: () => boolean };

// A response belongs to both the current refresh and the mounted hook's exact login session.
export function useNeteaseLibrarySession() {
    const generation = useRef(0);
    const lifetime = useRef<object | null>(null);
    useEffect(() => {
        const token = {};
        lifetime.current = token;
        return () => { generation.current++; if (lifetime.current === token) lifetime.current = null; };
    }, []);
    const captureRequest = useCallback((): NeteaseRequestFence => {
        const revision = generation.current, token = lifetime.current, cookie = readNeteaseSession();
        const current = () => token !== null && lifetime.current === token && generation.current === revision;
        return { current, active: () => current() && readNeteaseSession() === cookie };
    }, []);
    const beginRequest = useCallback(() => { generation.current++; return captureRequest(); }, [captureRequest]);
    const isAlive = useCallback(() => lifetime.current !== null, []);
    return { beginRequest, captureRequest, isAlive };
}
