import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// test/unit/onlineMusic/providerEofFacts.test.ts: the exact paused endpoint is cleanup evidence, never a new playable position.
const require = createRequire(import.meta.url);
const { playbackFacts, position } = require('../../../electron/spotify/desktopPlaybackFacts.cjs');
const { requireFacts } = require('../../../electron/spotify/cableAudioFacts.cjs');
const trackId = '3n3Ppam7vgaVa1iaRUc9Lp';
const expected = { deviceId: 'desktop', trackId, durationMs: 1800 };
const body = () => ({ device: { id: 'desktop', is_active: true, is_restricted: false },
  item: { type: 'track', uri: `spotify:track:${trackId}`, duration_ms: 1800 },
  is_playing: false, progress_ms: 1800, currently_playing_type: 'track' });
const record = { selection: { deviceId: 'desktop' }, resolvedTrackId: trackId, durationMs: 1800 };
it('accepts a paused selected track exactly at the end in both production fact validators', () => {
  const facts = playbackFacts(body(), expected);
  expect(facts.positionMs).toBe(1800); expect(requireFacts(facts, record, false)).toBe(facts);
  expect(position(1800, 1800)).toBe(false);
});
it.each(['playing', 'past-end', 'other-track', 'other-device'] as const)('rejects %s as a terminal selected-track fact', scenario => {
  const input = body();
  if (scenario === 'playing') input.is_playing = true;
  if (scenario === 'past-end') input.progress_ms++;
  if (scenario === 'other-track') input.item.uri = 'spotify:track:4n4Qqam7vgaVa1iaRUc9Lp';
  if (scenario === 'other-device') input.device.id = 'other';
  expect(() => playbackFacts(input, expected)).toThrow();
});
