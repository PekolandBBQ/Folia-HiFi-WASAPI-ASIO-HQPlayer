import { autoConnectSpotify } from './spotifyAutoConnect';
// One background check is shared by startup, setup signals and playlist clicks.
export function createSpotifyReadiness(check: () => Promise<{ ready: boolean; detail?: string }>, wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))) {
    let generation = 0, pending: Promise<boolean> | null = null;
    let state = { status: 'idle' as 'idle' | 'checking' | 'ready' | 'failed', retries: 0, detail: '' };
    return {
        state: () => state,
        reset() { generation++; pending = null; state = { status: 'idle', retries: 0, detail: '' }; },
        run() {
            if (pending) return pending;
            if (state.status === 'ready') return Promise.resolve(true);
            const owner = generation;
            pending = (async () => {
                for (let attempt = 0; attempt <= 3; attempt++) {
                    if (attempt) await wait(300 * attempt);
                    if (owner !== generation) return false;
                    state = { ...state, status: 'checking', retries: attempt };
                    try {
                        const result = await check();
                        if (owner !== generation) return false;
                        if (result.ready) { state = { status: 'ready', retries: attempt, detail: '' }; return true; }
                        state = { ...state, detail: result.detail || 'Spotify 尚未连接成功。' };
                    } catch (error) {
                        if (owner !== generation) return false;
                        const failure = error as { message?: string; httpStatus?: number; code?: string; details?: { userMessage?: string; httpStatus?: number } };
                        state = { ...state, detail: failure.details?.userMessage || (/[\u3400-\u9fff]/.test(failure.message || '') ? failure.message! : '无法完成 Spotify 连接检查，请在向导中查看连接状态。') };
                        if (failure.httpStatus === 429 || failure.details?.httpStatus === 429 || failure.code === 'rate-limited') { state.status = 'failed'; return false; }
                    }
                }
                state = { ...state, status: 'failed' }; return false;
            })().finally(() => { if (owner === generation) pending = null; });
            return pending;
        },
    };
}
export const spotifyReadiness = createSpotifyReadiness(autoConnectSpotify);
