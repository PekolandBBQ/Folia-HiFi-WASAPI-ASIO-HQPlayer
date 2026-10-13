import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// test/unit/exclusive/privateDevelopment.test.ts — private bootstrap isolation with actual filesystem catalogs.
const require = createRequire(import.meta.url);
const helper = require('../../../packaging/exclusive/privateDevelopment.cjs');
const builder = require('../../../packaging/exclusive/build-private-development.cjs');
const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-private-package-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
    const root = temporary(), appData = path.join(root, 'appdata'), resourcesPath = path.join(root, 'electron/resources');
    const resourceDirectory = path.join(resourcesPath, 'exclusive-native-audio');
    fs.mkdirSync(resourceDirectory, { recursive: true }); fs.mkdirSync(appData);
    const releases = ['native', 'hqp'].map(name => {
        const bytes = Buffer.from(`nonexecuted archive fixture ${name}`), archive = `${name}.zip`;
        fs.writeFileSync(path.join(resourceDirectory, archive), bytes);
        return { version: '0.1.0-preview.1', protocolMajor: 1, platform: 'win32-x64', archive, sha256: helper.sha256(bytes), entrySha256: 'a'.repeat(64) };
    });
    const paths: Record<string, string> = { appData, userData: path.join(appData, 'Folia') };
    const app = { isPackaged: false, getPath: (name: string) => paths[name], setPath: (name: string, value: string) => { paths[name] = value; }, setName: vi.fn() };
    const buildInfo = { appVersion: helper.PRIVATE_VERSION, electronVersion: helper.ELECTRON_VERSION,
        purpose: 'private-development-only', publicReleaseApproved: false, windowsExecutionTested: false,
        soloistManifestSha256: 'b'.repeat(64) };
    const environment: Record<string, string> = {
        FOLIA_SPOTIFY_PREVIEW_DIRECTORY: path.join(root, 'old-account'), FOLIA_SPOTIFY_NATIVE_PATH: 'old-native.exe',
        FOLIA_SOLOIST_COMPONENT_DIRECTORY: 'old-component', FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256: 'c'.repeat(64),
        FOLIA_NATIVE_COMPONENT_CATALOG: 'old-native.json', FOLIA_HQPLAYER_COMPONENT_CATALOG: 'old-hqp.json',
        FOLIA_SPOTIFY_COMPONENT_CATALOG: 'old-spotify.json', FOLIA_DEV_UPDATE_PREVIEW: 'true',
        FOLIA_NATIVE_FFMPEG_PATH: 'old-ffmpeg.exe', FOLIA_TRANSCODE_FFMPEG_PATH: 'old-transcoder.exe',
        FOLIA_SPOTIFY_CLIENT_ID: 'old-client', FOLIA_SPOTIFY_REDIRECT_URI: 'old-redirect',
    };
    return { root, appData, resourcesPath, resourceDirectory, paths, app, buildInfo, environment,
        approved: { nativeAudio: [releases[0]], hqplayer: [releases[1]] }, releases };
}

describe('private development bootstrap', () => {
    it('uses the stable isolated profile and replaces inherited experimental paths without changing packaged state', () => {
        const f = fixture();
        const old = path.join(f.appData, 'Folia'); fs.mkdirSync(old); fs.writeFileSync(path.join(old, 'config.json'), 'preserve original');
        Object.defineProperty(f.app, 'isPackaged', { value: false, writable: false });
        const configured = helper.configurePrivateDevelopment(f);
        expect(configured.profile).toBe(path.join(f.appData, 'Folia HiFi Private Development 20261006'));
        expect(f.paths.userData).toBe(configured.profile);
        expect(f.app.isPackaged).toBe(false);
        expect(f.app.setName).toHaveBeenCalledWith('Folia HiFi Private Development');
        expect(f.environment).toMatchObject({ FOLIA_SPOTIFY_PREVIEW: '1', FOLIA_PRIVATE_DIAGNOSTICS: '1',
            FOLIA_SPOTIFY_PREVIEW_DIRECTORY: path.join(configured.profile, 'spotify'), FOLIA_SPOTIFY_NATIVE_PATH: '',
            FOLIA_SPOTIFY_COMPONENT_CATALOG: '', FOLIA_SOLOIST_COMPONENT_DIRECTORY: path.join(f.resourcesPath, 'spotify-soloist-appliance'),
            FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256: 'b'.repeat(64), FOLIA_DEV_UPDATE_PREVIEW: 'false',
            FOLIA_NATIVE_FFMPEG_PATH: path.join(f.resourcesPath, 'ffmpeg-audio/ffmpeg.exe'),
            FOLIA_TRANSCODE_FFMPEG_PATH: path.join(f.resourcesPath, 'ffmpeg-audio/ffmpeg.exe'),
            FOLIA_SPOTIFY_CLIENT_ID: 'fddda707849c459ab149149bc79a0bd2', FOLIA_SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:43821/callback' });
        expect(fs.readFileSync(path.join(old, 'config.json'), 'utf8')).toBe('preserve original');
        expect(fs.readdirSync(configured.spotifyDirectory)).toEqual([]);
        expect(fs.existsSync(path.join(configured.profile, 'components'))).toBe(false);
        const catalog = JSON.parse(fs.readFileSync(configured.nativeCatalogPath, 'utf8'));
        expect(catalog.releases[0]).toMatchObject({ localPath: path.join(f.resourceDirectory, 'native.zip'), sha256: f.releases[0].sha256 });
    });
    it('preserves private account state, explicit component disable and unrelated saved preferences on relaunch', () => {
        const f = fixture(), configured = helper.configurePrivateDevelopment(f);
        fs.writeFileSync(path.join(configured.spotifyDirectory, 'existing-state.json'), 'keep private state');
        fs.mkdirSync(path.join(configured.profile, 'components/native-audio'), { recursive: true });
        fs.writeFileSync(path.join(configured.profile, 'components/native-audio/inactive.json'), 'disabled');
        helper.configurePrivateDevelopment(f);
        expect(fs.readFileSync(path.join(configured.spotifyDirectory, 'existing-state.json'), 'utf8')).toBe('keep private state');
        expect(fs.readFileSync(path.join(configured.profile, 'components/native-audio/inactive.json'), 'utf8')).toBe('disabled');
    });
    it('refuses packaged startup instead of spoofing app.isPackaged', () => {
        const f = fixture(); f.app.isPackaged = true;
        expect(() => helper.configurePrivateDevelopment(f)).toThrow('official Electron default-app launch');
        expect(f.app.isPackaged).toBe(true);
        expect(fs.readdirSync(f.appData)).toEqual([]);
    });
    it('refuses a changed component archive before publishing catalogs', () => {
        const f = fixture(); fs.writeFileSync(path.join(f.resourceDirectory, 'hqp.zip'), 'changed bytes');
        expect(() => helper.configurePrivateDevelopment(f)).toThrow('checksum mismatch');
        const profile = path.join(f.appData, helper.PRIVATE_PROFILE);
        expect(fs.existsSync(path.join(profile, 'private-native-audio-catalog.json'))).toBe(false);
    });

    it('rejects public approval and mismatched private build identities', () => {
        for (const changed of [{ publicReleaseApproved: true }, { windowsExecutionTested: true }, { appVersion: '0.7.12' }, { electronVersion: '43.7.6' }]) {
            const f = fixture(); Object.assign(f.buildInfo, changed);
            expect(() => helper.configurePrivateDevelopment(f)).toThrow('build identity is invalid');
        }
    });
    it('writes only the two update preferences in the explicitly selected private profile', () => {
        const f = fixture(), { profile } = helper.configurePrivateDevelopment(f), set = vi.fn(), create = vi.fn();
        class Store { constructor(options: unknown) { create(options); } set = set; }
        helper.disablePrivateUpdates({ app: f.app, profile, Store });
        expect(create).toHaveBeenCalledWith({ projectName: 'Folia', cwd: profile });
        expect(set.mock.calls).toEqual([['ENABLE_UPDATE_CHECK', false], ['ENABLE_AUTO_UPDATE', false]]);
        f.paths.userData = path.join(f.appData, 'Folia');
        expect(() => helper.disablePrivateUpdates({ app: f.app, profile, Store })).toThrow('isolated profile');
        expect(create).toHaveBeenCalledOnce();
    });
    it('installs diagnostics before main and observes the existing rejection handler afterward', () => {
        const f = fixture(), order: string[] = [], observed = vi.fn(() => order.push('observe'));
        const filename = path.resolve('packaging/exclusive/private-development-entry.cjs');
        const localRequire = (id: string) => {
            if (id === 'electron') return { app: f.app, ipcMain: {}, dialog: {}, shell: {} };
            if (id === 'node:path') return path;
            if (id === './privateDevelopment.cjs') return { configurePrivateDevelopment: () => { order.push('configure'); return { profile: '/private/profile' }; }, disablePrivateUpdates: () => order.push('updates') };
            if (id === './private-development-build.json') return f.buildInfo;
            if (id === './private-development-approved.json') return f.approved;
            if (id === './debug/privatePreviewDiagnostics.cjs') return { installPrivatePreviewDiagnostics: (options: any) => {
                expect(options.rendererEntry).toBe(path.resolve('/installed/app/dist/index.html'));
                expect(options.profile).toBe('/private/profile'); order.push('diagnostics'); return { observeExistingRejectionHandler: observed };
            } };
            if (id === 'electron-store') return class {};
            if (id === './main.cjs') { order.push('main'); return {}; }
            throw new Error(`Unexpected entry dependency ${id}`);
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: localRequire, __dirname: '/installed/app/electron', process: { resourcesPath: '/installed/electron/resources' } }, { filename });
        expect(order).toEqual(['configure', 'diagnostics', 'updates', 'main', 'observe']);
    });
});

describe('private payload staging helpers', () => {
    it('prunes only copied ONNX platform/architecture payloads and Koffi variants', () => {
        expect(builder.includeProductionFile('node_modules/onnxruntime-node', 'bin/napi-v6/win32/x64/onnxruntime.dll')).toBe(true);
        for (const file of ['bin/napi-v6/win32/arm64', 'bin/napi-v6/linux', 'bin/napi-v6/darwin/arm64/native.node'])
            expect(builder.includeProductionFile('node_modules/onnxruntime-node', file)).toBe(false);
        expect(builder.includeProductionFile('node_modules/onnxruntime-node', 'dist/binding.js')).toBe(true);
        expect(builder.includeProductionFile('node_modules/@koromix/koffi-linux-x64', '')).toBe(false);
        expect(builder.includeProductionFile('node_modules/@koromix/koffi-win32-x64', 'koffi.node')).toBe(true);
        expect(builder.includeProductionFile('node_modules/example', 'node_modules/dev-dependency/index.js')).toBe(false);
    });
    it('copies only selected closure entries and leaves the working dependencies untouched', () => {
        const root = temporary(), out = path.join(root, 'payload'), module = path.join(root, 'node_modules/onnxruntime-node');
        for (const file of ['dist/binding.js', 'bin/napi-v6/win32/x64/native.node', 'bin/napi-v6/linux/x64/native.node']) {
            fs.mkdirSync(path.dirname(path.join(module, file)), { recursive: true }); fs.writeFileSync(path.join(module, file), file);
        }
        builder.copyProductionDependencies(root, out, ['node_modules/onnxruntime-node']);
        expect(fs.existsSync(path.join(out, 'node_modules/onnxruntime-node/bin/napi-v6/linux'))).toBe(false);
        expect(fs.readFileSync(path.join(module, 'bin/napi-v6/linux/x64/native.node'), 'utf8')).toContain('linux/x64');
        expect(fs.existsSync(path.join(out, 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/native.node'))).toBe(true);
    });

    it('uses per-file NSIS directives with escaped literal paths', () => {
        const root = temporary(); fs.mkdirSync(path.join(root, 'app')); fs.writeFileSync(path.join(root, 'app/$value.txt'), 'fixture');
        const script = builder.payloadInclude(root);
        expect(script).toContain('SetOutPath "$INSTDIR\\app"');
        expect(script).toContain('File "/oname=$$value.txt"');
        expect(builder.nsisQuote('a"b')).toBe('a$\\"b');
        expect(() => builder.nsisQuote('line\nbreak')).toThrow('Invalid NSIS path');
        const installer = fs.readFileSync('packaging/exclusive/private-development-installer.nsi', 'utf8');
        expect(installer).toContain('SetCompressor lzma'); expect(installer).not.toContain('/SOLID');
        expect(installer).toContain('RequestExecutionLevel user');
        expect(installer).toContain('MUI_FINISHPAGE_RUN_NOTCHECKED');
        expect(installer).toContain('InstallDir "$LOCALAPPDATA\\FoliaHiFiPrivateDevelopment-20261006"');
        expect(installer).toContain('$APPDATA\\Folia HiFi Private Development 20261006\\diagnostics');
        expect(installer).not.toMatch(/(?:RMDir|Delete).*\$APPDATA/);
        expect(installer).not.toMatch(/taskkill|nsProcess|CreateService|sc\.exe/i);
    });
});
