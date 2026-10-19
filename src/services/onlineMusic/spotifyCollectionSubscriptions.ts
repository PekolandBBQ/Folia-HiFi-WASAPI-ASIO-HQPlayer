import type { ProviderCollection } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { requestSpotify } from './spotifyTransport';
import { normalizeSpotifyCollection, normalizeSpotifyPage, normalizeSpotifyUser } from './spotifyNormalize';
import { publishOnlineLibraryChange } from './libraryChanges';

// Serialize a confirmed Spotify write and its fresh full-library read; never synthesize membership locally.
let writes: Promise<unknown> = Promise.resolve();
export const setSpotifyCollectionSubscription = (kind: 'album' | 'artist', id: string | number, subscribed: boolean): Promise<void> => {
    const task = writes.catch(() => {}).then(async () => {
        const key = String(id);
        const receipt = await requestSpotify<{id:string;type:string;subscribed:boolean;confirmed:boolean;accountId:string}>({action:'subscribeCollection',collectionType:kind,id:key,subscribed});
        if (!receipt?.confirmed || receipt.id !== key || receipt.type !== kind || receipt.subscribed !== subscribed || !receipt.accountId)
            throw new OnlineProviderError('unavailable', 'Spotify 尚未确认关注或收藏状态，未更新本地显示。', 'spotify');
        let collections: ProviderCollection[] = [];
        for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 250));
            collections = []; let offset = 0;
            for (;;) {
                const page = normalizeSpotifyPage(await requestSpotify({action:kind === 'album' ? 'albums' : 'artists',limit:50,offset}),offset,normalizeSpotifyCollection);
                collections.push(...page.items);
                if (!page.hasMore || page.nextOffset <= offset) break;
                offset = page.nextOffset;
            }
            const user = normalizeSpotifyUser(await requestSpotify({action:'status'}));
            if (!user) throw new OnlineProviderError('unavailable', 'Spotify 已确认操作，但账号状态暂未返回，未将收藏列表标记为同步成功。', 'spotify');
            if (String(user?.id) !== receipt.accountId) throw new OnlineProviderError('unavailable', 'Spotify 账号已改变，未应用原账号的收藏结果。', 'spotify');
            if (collections.some(item => String(item.id) === key) === subscribed) {
                publishOnlineLibraryChange({providerId:'spotify',accountId:receipt.accountId,kind,id:key,subscribed,collections});
                return;
            }
        }
        throw new OnlineProviderError('unavailable', 'Spotify 已确认操作，但收藏列表尚未同步；未将列表标记为更新成功，请稍后重试。', 'spotify');
    });
    writes = task;
    return task;
};
