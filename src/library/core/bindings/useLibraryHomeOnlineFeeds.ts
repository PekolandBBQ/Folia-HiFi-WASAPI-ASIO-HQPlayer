import { useEffect, useSyncExternalStore } from 'react';
import type { HomeViewTab } from '../../../types';
import type { MediaId } from '../../../types/onlineMusic';
import { createFavoriteArtistsFeed } from '../services/onlineHomeFeeds';
import type {
    LibraryHomeFeedOwner,
    LibraryHomeFeedResource,
    LibraryHomeFeedSnapshot,
    LibraryHomeResources,
} from '../contracts/homeModel';

// src/library/core/bindings/useLibraryHomeOnlineFeeds.ts
// 在线首页数据的绑定：把当前 provider / 账户设成两份资源的归属，看着哪个页签就让哪份资源读一次，
// 并订阅它们的快照。归属与读取在同一个 effect 里按顺序做（先换归属、再 ensure），所以切 provider 之后
// 新 provider 的收藏专辑 / 电台一定会读——原先两个 effect 的先后让它永远不读。
// 这里不在卸载时放掉归属：资源属于首页宿主，换 suite（旧 surface 卸载、新 surface 挂载）时新 surface 设的是
// 同一个归属、ensure 也不再读；首页真的离开时由宿主放掉（core/services/libraryHomeLifetime）。

export const useLibraryHomeFeed = <TData>(resource: LibraryHomeFeedResource<TData>): LibraryHomeFeedSnapshot<TData> => (
    useSyncExternalStore(resource.subscribe, resource.getSnapshot)
);

const ownerOf = (providerId: string, userId: MediaId | null | undefined, capable: boolean): LibraryHomeFeedOwner | null => (
    capable && userId !== null && userId !== undefined ? { providerId, userId } : null
);

type OnlineHomeFeedsAttachment = {
    tab: HomeViewTab;
    providerId: string;
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    canUseArtists?: boolean;
};

/**
 * 正在显示的首页 surface 认领两份在线数据：先把归属设成当前 provider / 账户，再让当前页签的那份读一次。
 * 同一个归属、已经读过时什么都不做——换 suite 后新 surface 认领同一份数据不会再请求。
 */
export const attachOnlineHomeFeeds = (
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'favoriteArtists' | 'radioFeed'>,
    { tab, providerId, userId, canUseAlbums, canUseArtists, canUseRadio }: OnlineHomeFeedsAttachment,
): void => {
    resources.favoriteAlbums.setOwner(ownerOf(providerId, userId, canUseAlbums));
    resources.favoriteArtists?.setOwner(ownerOf(providerId,userId,canUseArtists===true));
    resources.radioFeed.setOwner(ownerOf(providerId, userId, canUseRadio));
    if (tab === 'albums') void resources.favoriteAlbums.ensure();
    if (tab === 'artists') void resources.favoriteArtists?.ensure();
    if (tab === 'radio') void resources.radioFeed.ensure();
};

export const useLibraryHomeOnlineFeeds = ({
    resources,
    tab,
    providerId,
    userId,
    canUseAlbums,
    canUseRadio,
    canUseArtists,
}: {
    resources: Pick<LibraryHomeResources, 'favoriteAlbums' | 'favoriteArtists' | 'radioFeed'>;
    tab: HomeViewTab;
    providerId: string;
    /** 当前 provider 的已登录账户（没有账户时为 null：两份数据都没有归属）。 */
    userId: MediaId | null | undefined;
    canUseAlbums: boolean;
    canUseRadio: boolean;
    canUseArtists?: boolean;
}) => {
    const { favoriteAlbums, radioFeed } = resources;
    const favoriteArtists=resources.favoriteArtists||EMPTY_ARTISTS;
    useEffect(() => {
        attachOnlineHomeFeeds({ favoriteAlbums, favoriteArtists, radioFeed }, { tab, providerId, userId, canUseAlbums, canUseArtists, canUseRadio });
    }, [canUseAlbums, canUseArtists, canUseRadio, favoriteAlbums, favoriteArtists, providerId, radioFeed, tab, userId]);

    return {
        favoriteAlbums: useLibraryHomeFeed(favoriteAlbums),
        favoriteArtists: useLibraryHomeFeed(favoriteArtists),
        radioFeed: useLibraryHomeFeed(radioFeed),
    };
};

const EMPTY_ARTISTS=createFavoriteArtistsFeed({});
