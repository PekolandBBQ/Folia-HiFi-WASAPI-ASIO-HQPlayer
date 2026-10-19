import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderCollection } from '../types/onlineMusic';
import { omni } from '../services/onlineMusic/omni';
import { subscribeOnlineLibraryChanges } from '../services/onlineMusic/libraryChanges';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';

// One account-bound status/write lifecycle shared by artist surfaces and collection controls.
export const useOnlineCollectionSubscription = (collection: ProviderCollection | null) => {
    const { t } = useTranslation();
    const providerId = collection?.providerId || '', id = String(collection?.id || ''), kind = collection?.type || '';
    const accountId = useOnlineProviderAccountStore(state => state.accounts[providerId]?.user?.id);
    const key = `${providerId}:${accountId}:${kind}:${id}`;
    const supported = Boolean(collection && omni.canSubscribeCollection(collection));
    const [state, setState] = useState<{key:string;subscribed:boolean|null;pending:boolean;error:string|null}>({key,subscribed:null,pending:false,error:null});
    const generation = useRef(0), busy = useRef(false), latest = useRef(collection);
    latest.current = collection;
    const message = useCallback((error: unknown) => error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : t('catalogSubscription.failed'), [t]);
    const isCurrent = useCallback((ticket:number) => ticket === generation.current && String(useOnlineProviderAccountStore.getState().accounts[providerId]?.user?.id) === String(accountId), [providerId,accountId]);
    const refresh = useCallback(async () => {
        const current = latest.current;if (!current || !supported) return;
        const ticket = ++generation.current;busy.current = true;
        setState({key,subscribed:null,pending:true,error:null});
        try {
            const subscribed = await omni.getSubscriptionStatus(current);
            if (isCurrent(ticket)) setState({key,subscribed,pending:false,error:null});
        } catch (error) {
            if (isCurrent(ticket)) setState({key,subscribed:null,pending:false,error:message(error)});
        } finally { if (ticket === generation.current) busy.current = false; }
    }, [key, supported, message, isCurrent]);
    useEffect(() => {
        void refresh();
        return () => { generation.current++;busy.current = false; };
    }, [refresh]);
    useEffect(() => subscribeOnlineLibraryChanges(change => {
        if (change.providerId === providerId && change.accountId === String(accountId) && change.kind === kind && change.id === id)
            setState(previous => ({...previous,key,subscribed:change.subscribed,error:null}));
    }), [key,providerId,accountId,kind,id]);
    const toggle = async () => {
        if (busy.current || !supported || !latest.current) return;
        if (state.key !== key || state.subscribed === null) { await refresh();return; }
        const ticket = generation.current, target = !state.subscribed, current = latest.current;
        busy.current = true;setState(previous => ({...previous,pending:true,error:null}));
        try {
            await omni.subscribe(current,target);
            if (isCurrent(ticket)) setState({key,subscribed:target,pending:false,error:null});
        } catch (error) {
            if (isCurrent(ticket)) setState(previous => ({...previous,pending:false,error:message(error)}));
        } finally { if (ticket === generation.current) busy.current = false; }
    };
    const visible = state.key === key ? state : {subscribed:null,pending:true,error:null};
    const label = visible.subscribed === null && visible.error ? t('catalogSubscription.retry') : kind === 'artist'
        ? t(visible.subscribed ? 'catalogSubscription.unfollow' : 'catalogSubscription.follow')
        : t(visible.subscribed ? 'catalogSubscription.unsave' : 'catalogSubscription.save');
    return {...visible,supported,toggle,label,refresh};
};
