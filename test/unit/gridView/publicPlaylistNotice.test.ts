import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../../src/i18n/config';
import CollectionMetadataNotice from '../../../src/library/suites/grid/shared/CollectionMetadataNotice';
import type { ProviderMetadataStatus } from '../../../src/types/onlineMusic';

// publicPlaylistNotice.test.ts — Presentation content checks; these do not claim visual/browser coverage.
const publicMetadata: ProviderMetadataStatus = {
    metadataSource: 'spotify-public-embed', metadataCompleteness: 'partial', loadedCount: 23,
    sourceUrl: 'https://open.spotify.com/playlist/5ZAFjUGN7Wsip8May2qDuq',
};
const render = (metadata: ProviderMetadataStatus | null) => renderToStaticMarkup(createElement(CollectionMetadataNotice, { metadata }));
beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('public playlist visible coverage and original link', () => {
    it('labels the actual row count as partial and total unknown, with a safe canonical origin', () => {
        const output = render(publicMetadata);
        expect(output).toContain('23 track entries');
        expect(output).toContain('may be incomplete');
        expect(output).toContain('total is not confirmed');
        expect(output).toContain('role="status"');
        expect(output).toContain('href="https://open.spotify.com/playlist/5ZAFjUGN7Wsip8May2qDuq"');
        expect(output).toContain('rel="noopener noreferrer"');
    });
    it('clears the notice on API and closed states, including repeated changes', () => {
        for (let index = 0; index < 3; index++) {
            expect(render(publicMetadata)).toContain('may be incomplete');
            expect(render({ metadataSource: 'spotify-api' })).toBe('');
            expect(render(null)).toBe('');
        }
    });
    it('does not render an unsafe or noncanonical source as a link', () => {
        expect(render({ ...publicMetadata, sourceUrl: 'https://evil.test/playlist' })).not.toContain('<a');
        expect(render({ ...publicMetadata, sourceUrl: 'javascript:alert(1)' })).not.toContain('javascript:');
    });
    it('shows the coverage caveat in Chinese', async () => {
        await i18n.changeLanguage('zh-CN');
        const output = render(publicMetadata);
        expect(output).toContain('23');
        expect(output).toContain('可能不完整');
        expect(output).toContain('总数尚未确认');
        expect(output).toContain('查看原歌单');
    });
});
