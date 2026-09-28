import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// test/unit/exclusive/profile.test.ts
const require = createRequire(import.meta.url);
const { prepareProfile } = require('../../../packaging/exclusive/profile.cjs');
const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-profile-test-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) if (path.dirname(dir) === path.resolve(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true }); });
describe('fork profile migration', () => {
    it('creates a fresh named profile without a legacy profile', () => {
        const dir = root();
        expect(prepareProfile(dir, 'Folia HiFi', 'FoliaExclusive')).toBe(path.join(dir, 'Folia HiFi'));
        expect(fs.existsSync(path.join(dir, 'FoliaExclusive'))).toBe(false);
    });
    it('copies settings, library and component pointers while preserving the original', () => {
        const dir = root(), legacy = path.join(dir, 'FoliaExclusive');
        fs.mkdirSync(path.join(legacy, 'IndexedDB'), { recursive: true });
        fs.writeFileSync(path.join(legacy, 'config.json'), '{"volume":0.1}');
        fs.writeFileSync(path.join(legacy, 'IndexedDB', 'library'), 'library-record');
        fs.writeFileSync(path.join(legacy, 'SingletonLock'), 'stale-lock');
        const target = prepareProfile(dir, 'Folia HiFi', 'FoliaExclusive');
        expect(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).toBe('{"volume":0.1}');
        expect(fs.readFileSync(path.join(target, 'IndexedDB', 'library'), 'utf8')).toBe('library-record');
        expect(fs.existsSync(path.join(target, 'SingletonLock'))).toBe(false);
        expect(fs.readFileSync(path.join(legacy, 'SingletonLock'), 'utf8')).toBe('stale-lock');
    });
    it('never merges or overwrites an existing new profile', () => {
        const dir = root();
        for (const name of ['FoliaExclusive', 'Folia HiFi']) { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'config.json'), name); }
        const target = prepareProfile(dir, 'Folia HiFi', 'FoliaExclusive');
        expect(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).toBe('Folia HiFi');
    });
    it('does not publish a partial profile after a copy failure and can retry', () => {
        const dir = root(), legacy = path.join(dir, 'FoliaExclusive'); fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'config.json'), 'keep');
        expect(() => prepareProfile(dir, 'Folia HiFi', 'FoliaExclusive', { ...fs, cpSync: () => { throw new Error('disk full'); } })).toThrow('disk full');
        expect(fs.existsSync(path.join(dir, 'Folia HiFi'))).toBe(false);
        expect(fs.readFileSync(path.join(legacy, 'config.json'), 'utf8')).toBe('keep');
        expect(fs.existsSync(prepareProfile(dir, 'Folia HiFi', 'FoliaExclusive'))).toBe(true);
    });
    it('rejects a profile path outside AppData', () => {
        expect(() => prepareProfile(root(), '../escape', 'FoliaExclusive')).toThrow('Invalid profile name');
    });
});
