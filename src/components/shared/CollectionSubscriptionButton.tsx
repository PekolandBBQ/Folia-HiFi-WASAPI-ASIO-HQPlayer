import React from 'react';
import { Loader2, Star, UserCheck, UserPlus } from 'lucide-react';
import type { ProviderCollection } from '../../types/onlineMusic';
import { useOnlineCollectionSubscription } from '../../hooks/useOnlineCollectionSubscription';

// The same rounded control and verified status in grid, TUI and artist metadata panels.
export const CollectionSubscriptionButton = ({collection}: {collection:ProviderCollection|null}) => {
    const state = useOnlineCollectionSubscription(collection);
    if (!state.supported) return null;
    const Icon = state.pending ? Loader2 : collection?.type === 'artist' ? state.subscribed ? UserCheck : UserPlus : Star;
    return <div className="flex flex-col gap-1">
        <button type="button" disabled={state.pending} aria-pressed={state.subscribed === true} onClick={() => void state.toggle()}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-current/20 px-4 py-2 text-xs font-semibold hover:bg-current/10 disabled:opacity-50">
            <Icon size={14} className={state.pending ? 'animate-spin' : ''} />{state.label}
        </button>
        {state.error && <p role="alert" className="max-w-sm text-xs opacity-70">{state.error}</p>}
    </div>;
};
