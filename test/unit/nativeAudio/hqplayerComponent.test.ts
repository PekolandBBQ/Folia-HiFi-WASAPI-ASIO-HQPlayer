import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { zipSync } from 'fflate';
const require = createRequire(import.meta.url);
const { createHQPlayerComponentManager } = require('../../../electron/hqplayer/componentManager.cjs');
const { createHQPlayerComponentHost } = require('../../../electron/hqplayer/client.cjs');
const { createComponentManager } = require('../../../electron/nativeAudio/componentManager.cjs');

// Artifact failures must not activate unverified code or alter the parallel native component.
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hqp-component-test-')); roots.push(root);
    const catalogPath = path.join(root, 'catalog.json'), releases: any[] = [];
    const app = { isPackaged: false, getPath: () => root };
    const verifyStaged = vi.fn(async () => {});
    const manager = createHQPlayerComponentManager({ app, catalogPath, verifyStaged });
    async function publish(version: string, badEntry = false) {
        const entry = Buffer.from(`// version ${version}`), name = path.join(root, `${version}.zip`);
        const archive = zipSync({ 'hqplayer-component.cjs': entry, 'component.json': Buffer.from(JSON.stringify({ id: 'hqplayer', version, protocolMajor: 1, entry: 'hqplayer-component.cjs' })) });
        await fs.writeFile(name, archive);
        releases.unshift({ version, protocolMajor: 1, platform: 'win32-x64', sha256: sha(archive), entrySha256: badEntry ? '0'.repeat(64) : sha(entry), localPath: name });
        await fs.writeFile(catalogPath, JSON.stringify({ schema: 1, releases }));
    }
    return { root, app, manager, catalogPath, verifyStaged, publish };
}
it('has an independent lifecycle, keeps compatible old versions active, and rolls back', async () => {
    const f = await fixture(); await f.publish('0.1.0');
    await fs.mkdir(path.join(f.root, 'components/native-audio'), { recursive: true });
    const nativePointer = path.join(f.root, 'components/native-audio/active.json');
    await fs.writeFile(nativePointer, 'native-is-unchanged');
    expect(await f.manager.install()).toMatchObject({ available: true, version: '0.1.0' });
    expect(f.verifyStaged).toHaveBeenCalledOnce();
    await f.publish('0.2.0');
    expect(await f.manager.status()).toMatchObject({ available: true, version: '0.1.0', updateAvailable: true });
    await f.manager.install(); expect(await f.manager.rollback()).toMatchObject({ version: '0.1.0' });
    await f.manager.uninstall(); expect(await f.manager.status()).toMatchObject({ available: false });
    expect(await fs.readFile(nativePointer, 'utf8')).toBe('native-is-unchanged');
});
it('leaves the working version active after a bad entry hash or failed handshake', async () => {
    const f = await fixture(); await f.publish('0.1.0'); await f.manager.install();
    await f.publish('0.2.0', true); await expect(f.manager.install()).rejects.toThrow('checksum');
    expect(await f.manager.status()).toMatchObject({ available: true, version: '0.1.0', busy: false });
    await f.publish('0.3.0'); f.verifyStaged.mockRejectedValueOnce(new Error('Handshake mismatch'));
    await expect(f.manager.install()).rejects.toThrow('Handshake');
    expect(await f.manager.status()).toMatchObject({ available: true, version: '0.1.0', busy: false });
});
it('checks the pinned entry hash instead of trusting an edited activation pointer', async () => {
    const f = await fixture(); await f.publish('0.1.0'); const installed = await f.manager.install();
    await fs.writeFile(installed.executable, 'tampered');
    const pointerPath = path.join(f.root, 'components/hqplayer/active.json');
    const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8')); pointer.executableSha256 = sha(Buffer.from('tampered'));
    await fs.writeFile(pointerPath, JSON.stringify(pointer));
    expect(await f.manager.status()).toMatchObject({ available: false, errorCode: 'COMPONENT_INTEGRITY' });
});
it('never uses a contributor/local artifact in an ordinary packaged application', async () => {
    const f = await fixture(); await f.publish('0.1.0'); const fetchImpl = vi.fn();
    const manager = createHQPlayerComponentManager({ app: { ...f.app, isPackaged: true }, catalogPath: f.catalogPath, fetchImpl });
    await expect(manager.install()).rejects.toMatchObject({ code: 'COMPONENT_INCOMPATIBLE' }); expect(fetchImpl).not.toHaveBeenCalled();
});
it('cannot install HQPlayer bytes into the WASAPI/ASIO component slot', async () => {
    const f = await fixture(); await f.publish('0.1.0');
    await expect(createComponentManager({ app: f.app, catalogPath: f.catalogPath }).install()).rejects.toThrow('archive path');
});
it('does not launch a worker when absent and refuses a mismatched protocol', async () => {
    const manager = { status: vi.fn(async () => ({ available: false, installed: false, installable: false })) };
    const rpcFactory = vi.fn(); const host = createHQPlayerComponentHost({ manager, rpcFactory });
    expect(await host.configuration()).toMatchObject({ available: false, component: { installed: false } });
    await expect(host.prepare()).rejects.toMatchObject({ code: 'COMPONENT_UNAVAILABLE' }); expect(rpcFactory).not.toHaveBeenCalled();
    manager.status.mockResolvedValue({ available: true, executable: 'verified.cjs', version: '0.1.0' } as any);
    const rpc = { request: vi.fn(async () => ({ id: 'hqplayer', protocolMajor: 2 })), dispose: vi.fn(async () => {}) }; rpcFactory.mockReturnValue(rpc);
    await expect(host.prepare()).rejects.toMatchObject({ code: 'COMPONENT_INCOMPATIBLE' }); expect(rpc.dispose).toHaveBeenCalledOnce();
});
