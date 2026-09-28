import { afterEach, expect, it, vi } from 'vitest';
import { isNativeAudioSupported } from '../../../src/services/nativeAudio/capabilities';
import { buildSettingsNavGroups } from '../../../src/components/modal/settings/navigation/settingsNavModel';
import { settingsCommands } from '../../../src/components/command-palette/commands/settingsCommands';
import type { CommandPaletteContext } from '../../../src/components/command-palette/types';

// test/unit/nativeAudio/capabilities.test.ts — settings navigation and all native commands share the runtime gate.
afterEach(() => vi.unstubAllGlobals());
const nativeIds = ['settings-native-audio', 'settings-toggle-native-auto-fallback', 'native-audio-signal-path-toggle', 'native-audio-integer-direct-toggle'];

it.each([
    ['Windows x64 desktop', 'win32', true, true],
    ['Windows unsupported architecture', 'win32', false, false],
    ['macOS even with a stale capability flag', 'darwin', true, false],
    ['Linux even with a stale capability flag', 'linux', true, false],
    ['browser without a desktop bridge', null, false, false],
] as const)('gates the module, sidebar and command entries for %s', (_name, platform, supported, expected) => {
    vi.stubGlobal('window', platform ? { electron: { platform, nativeAudio: { supported, request: vi.fn() } } } : {});
    expect(isNativeAudioSupported()).toBe(expected);
    const anchors = buildSettingsNavGroups(key => key, { isElectron: platform !== null })
        .flatMap(group => group.items.flatMap(item => item.anchors.map(anchor => anchor.id)));
    expect(anchors.includes('nativeAudioOutput')).toBe(expected);
    for (const id of nativeIds) {
        const command = settingsCommands.find(command => command.id === id)!;
        expect(command.isAvailable?.({} as CommandPaletteContext), id).toBe(expected);
    }
});

it('does not advertise settings when the preload IPC bridge is incomplete', () => {
    vi.stubGlobal('window', { electron: { platform: 'win32', nativeAudio: { supported: true } } });
    expect(isNativeAudioSupported()).toBe(false);
});
