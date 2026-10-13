import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const { normalizeScope, mergeGrantedScope } = createRequire(import.meta.url)('../../../electron/spotify/grantScopes.cjs');

// test/unit/onlineMusic/spotifyGrantScopes.test.ts: validate actual OAuth scope metadata at the service boundary.
describe('Spotify granted scope normalization', () => {
  it('normalizes case-sensitive granted tokens and preserves unknown versus empty', () => {
    expect(normalizeScope('user-read-private  user-read-playback-state user-read-private')).toBe('user-read-playback-state user-read-private');
    expect(normalizeScope('Scope scope')).toBe('Scope scope');
    expect(normalizeScope(undefined)).toBeNull(); expect(normalizeScope('')).toBe('');
  });
  it('inherits an omitted refresh scope, while explicit responses replace it', () => {
    expect(mergeGrantedScope('old', {}, { refresh: true })).toBe('old');
    expect(mergeGrantedScope('old', {})).toBeNull(); expect(mergeGrantedScope(null, {}, { refresh: true })).toBeNull();
    expect(mergeGrantedScope('old', { scope: 'new' }, { refresh: true })).toBe('new');
    expect(mergeGrantedScope('old', { scope: '' }, { refresh: true })).toBe('');
  });
  it.each([[], 1, 'bad\tpermission', 'bad"permission', 'bad\\permission', 'a'.repeat(4097)])('uses the typed service error for invalid scope %j', value => {
    expect(() => normalizeScope(value)).toThrow();
    try { normalizeScope(value); } catch (error) { expect(error).toMatchObject({ code: 'invalid-response' }); }
  });
});
