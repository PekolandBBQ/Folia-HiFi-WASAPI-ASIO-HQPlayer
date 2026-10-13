import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Public app settings are local and must not let a redirect send authorization codes off-device.
const { readClientSettings } = createRequire(import.meta.url)('../../../electron/spotify/clientSettings.cjs');
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixture(value: object) {
    const dir = await mkdtemp(path.join(tmpdir(), 'folia-spotify-client-')); folders.push(dir);
    await writeFile(path.join(dir, 'client.json'), JSON.stringify(value)); return dir;
}
describe('Spotify public client configuration', () => {
    it('loads the configured loopback callback without returning unknown fields', async () => {
        const directory = await fixture({ clientId: 'a'.repeat(32), redirectUri: 'http://127.0.0.1:43821/callback', clientSecret: 'must-never-be-used' });
        expect(readClientSettings(directory, {})).toEqual({ catalogClientId: 'a'.repeat(32), catalogRedirectUri: 'http://127.0.0.1:43821/callback' });
    });
    it('rejects remote or malformed callbacks', async () => {
        for (const redirectUri of ['https://example.com/callback', 'http://localhost:43821/callback', 'http://user@127.0.0.1:43821/callback', 'http://127.0.0.1:43821/callback?secret=1']) {
            const directory = await fixture({ clientId: 'a'.repeat(32), redirectUri });
            expect(() => readClientSettings(directory, {})).toThrow('invalid-redirect-uri');
        }
    });
});
