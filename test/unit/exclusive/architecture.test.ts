import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// test/unit/exclusive/architecture.test.ts — enforce separation of fork distribution and upstream runtime.
const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');
describe('exclusive distribution boundaries', () => {
    it('keeps the displayed version aligned with the upstream baseline', () => {
        const release = JSON.parse(read('packaging/exclusive/release.json'));
        const upstream = JSON.parse(read('package.json'));
        expect(release.version).toBe(upstream.version);
        expect(release.upstreamVersion).toBe(upstream.version);
        expect(release.profile).toBe('Folia HiFi');
    });
    it('keeps the upstream entry and identity independent of fork packaging', () => {
        const upstream = JSON.parse(read('package.json'));
        expect(upstream.main).toBe('electron/main.cjs');
        expect(upstream.build.appId).toBe('top.izuna.foliamajor');
        const files = ['electron/main.cjs', ...fs.readdirSync('electron/nativeAudio').filter(n => n.endsWith('.cjs')).map(n => `electron/nativeAudio/${n}`)];
        for (const file of files) expect(read(file), file).not.toMatch(/(?:packaging\/exclusive|exclusive-entry|Folia HiFi|FoliaExclusive)/);
    });
    it('keeps HQPlayer control modules independent of WASAPI component installation', () => {
        expect(read('electron/hqplayer/client.cjs')).not.toContain("require('../nativeAudio/componentManager");
        expect(read('electron/hqplayer/componentManager.cjs')).toContain("id: 'hqplayer'");
        for (const name of ['hqplayerHost', 'hqplayerDiscovery', 'hqplayerProtocol'])
            expect(fs.existsSync(`electron/nativeAudio/${name}.cjs`)).toBe(false);
    });
});
