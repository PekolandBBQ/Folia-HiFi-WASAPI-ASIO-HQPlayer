import { create } from 'zustand';

// src/stores/useNativeRecoveryStore.ts — ephemeral recovery actions, never persisted credentials.
export type NativeRecoveryChoice = 'retry' | 'browser' | 'rollback';
export const useNativeRecoveryStore = create<{
    errorCode: string | null;
    busy: boolean;
    choose: ((choice: NativeRecoveryChoice) => Promise<void>) | null;
}>(() => ({ errorCode: null, busy: false, choose: null }));
