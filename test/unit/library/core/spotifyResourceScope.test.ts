import { describe, expect, it } from 'vitest';
import { resolveCollectionResourceKey } from '@/library/core/services/createCollectionResource';
import type { OnlineGridViewCollectionDescriptor } from '@/library/core/contracts/collection';

describe('Spotify library resource account scope', () => {
    it('separates anonymous and authenticated collections across account changes', () => {
        const playlist: OnlineGridViewCollectionDescriptor = { source: 'online', providerId: 'spotify', id: 'liked', name: 'Liked songs', type: 'playlist' };
        const keys = [null, 'user-a', 'user-b'].map(id => resolveCollectionResourceKey(playlist, id));
        expect(new Set(keys).size).toBe(3);
        expect(resolveCollectionResourceKey(playlist, 'user-a')).toBe(keys[1]);
        const qq = { ...playlist, providerId: 'qq' };
        expect(resolveCollectionResourceKey(qq, 'user-a')).toBe(resolveCollectionResourceKey(qq, 'user-b'));
    });
});
