'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSoloistApplianceComposition } = require('./soloistApplianceComposition.cjs');
const { createSoloistApplianceOwner } = require('./soloistApplianceOwner.cjs');
const { downloadSoloistOfficialAsset } = require('./soloistOfficialAsset.cjs');
const { createSoloistApplianceSecrets } = require('./soloistApplianceSecrets.cjs');
const { parseBoundedResponse } = require('./soloistOwnedAppliance.cjs');

// Resolve only a separately approved, account-free component. Catalog/login
// construction never reads its files or starts a VM.
const fail = code => Object.assign(new Error(`Spotify appliance: ${code}`), { code });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const relativePath = value => typeof value === 'string' && value.length <= 1024 && value.split('/').every(part =>
    part.length > 0 && part.length <= 255 && part !== '.' && part !== '..'
    && !/[\x00-\x1f\x7f<>:"\\|?*]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);

// Bound the actual read, not only a preceding path stat that can change.
function readManifest(file) {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 2097152n) throw fail('APPLIANCE_COMPONENT_INVALID');
    const bytes = Buffer.alloc(Number(before.size)), descriptor = fs.openSync(file, 'r');
    try {
        if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true }))) throw fail('APPLIANCE_COMPONENT_CHANGED');
        let at = 0;
        while (at < bytes.length) {
            const count = fs.readSync(descriptor, bytes, at, bytes.length - at, null);
            if (!count) throw fail('APPLIANCE_COMPONENT_CHANGED'); at += count;
        }
        if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true })) || !sameFile(before, fs.lstatSync(file, { bigint: true })))
            throw fail('APPLIANCE_COMPONENT_CHANGED');
        return bytes;
    } finally { fs.closeSync(descriptor); }
}

// Hash from a fixed-size buffer: the approved clean disk can be several GB.
function fileHash(file, algorithm, expected) {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw fail('APPLIANCE_COMPONENT_INVALID');
    const buffer = Buffer.allocUnsafe(Math.max(1, Number(before.size < 1048576n ? before.size : 1048576n))), hash = createHash(algorithm);
    const descriptor = fs.openSync(file, 'r');
    try {
        if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true }))) throw fail('APPLIANCE_COMPONENT_CHANGED');
        let count; while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
        if (!sameFile(before, fs.fstatSync(descriptor, { bigint: true })) || !sameFile(before, fs.lstatSync(file, { bigint: true }))
            || hash.digest('hex') !== expected) throw fail('APPLIANCE_COMPONENT_CHANGED');
    } finally { fs.closeSync(descriptor); }
}

// The manifest is a complete inventory of both runtime trees, not a list of
// selected EXEs. QEMU firmware and Windows loader dependencies share this gate.
function componentInventory(root) {
    const files = new Map(), aliases = new Set(); let count = 0;
    const visit = (directory, prefix = '', depth = 0) => {
        if (depth > 32) throw fail('APPLIANCE_COMPONENT_INVALID');
        for (const name of fs.readdirSync(directory)) {
            const relative = prefix + name, file = path.join(directory, name);
            if (++count > 20000 || !relativePath(relative) || aliases.has(relative.toLowerCase())) throw fail('APPLIANCE_COMPONENT_INVALID');
            aliases.add(relative.toLowerCase());
            const info = fs.lstatSync(file, { bigint: true });
            if (info.isSymbolicLink()) throw fail('APPLIANCE_COMPONENT_INVALID');
            const actual = fs.realpathSync(file), contained = path.relative(root, actual);
            if (!contained || contained.startsWith('..' + path.sep) || path.isAbsolute(contained)) throw fail('APPLIANCE_COMPONENT_INVALID');
            if (info.isDirectory()) {
                if (!prefix && !['qemu', 'ssh'].includes(name)) throw fail('APPLIANCE_COMPONENT_INVALID');
                visit(file, relative + '/', depth + 1);
            } else if (info.isFile() && info.nlink === 1n) {
                if (prefix) files.set(relative, info);
                else if (!['component.manifest.json', 'folia-soloist-clean-base.qcow2'].includes(name) && !/\.(json|md|txt)$/i.test(name))
                    throw fail('APPLIANCE_COMPONENT_INVALID');
            } else throw fail('APPLIANCE_COMPONENT_INVALID');
        }
    };
    visit(root); return files;
}

function loadComponent({ directory, manifestSha256, packaged }, verifyBase) {
    if (process.type === 'renderer') throw fail('INVALID_REQUEST');
    if (!sha256(manifestSha256)) throw fail('APPLIANCE_COMPONENT_UNAVAILABLE');
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f\x7f"]/.test(directory)) throw fail('APPLIANCE_COMPONENT_INVALID');
    const root = fs.realpathSync(directory);
    if (!fs.statSync(root).isDirectory()) throw fail('APPLIANCE_COMPONENT_INVALID');
    const within = (relative, directory = false) => {
        if (!relativePath(relative)) throw fail('APPLIANCE_COMPONENT_INVALID');
        const original = path.join(root, relative), info = fs.lstatSync(original), resolved = fs.realpathSync(original), contained = path.relative(root, resolved);
        if (!contained || contained.startsWith('..' + path.sep) || path.isAbsolute(contained) || info.isSymbolicLink()
            || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw fail('APPLIANCE_COMPONENT_INVALID');
        return resolved;
    };
    const file = within('component.manifest.json');
    const bytes = readManifest(file);
    if (createHash('sha256').update(bytes).digest('hex') !== manifestSha256) throw fail('APPLIANCE_COMPONENT_CHANGED');
    let value; try { value = parseBoundedResponse(bytes); } catch { throw fail('APPLIANCE_COMPONENT_INVALID'); }
    if (!record(value)) throw fail('APPLIANCE_COMPONENT_INVALID');
    if (value.capabilities !== undefined && (!record(value.capabilities)
        || Object.keys(value.capabilities).join(',') !== 'codecDiagnostics'
        || typeof value.capabilities.codecDiagnostics !== 'boolean')) throw fail('APPLIANCE_COMPONENT_INVALID');
    if (value.schema !== 1 || value.id !== 'folia-spotify-soloist-qemu' || value.platform !== 'win32' || value.arch !== 'x64'
        || typeof value.releaseReady !== 'boolean' || packaged && value.releaseReady !== true || value.soloist?.bundled !== false
        || value.soloist?.perUserOfficialDownload !== true || value.owner?.runtimeDirectory !== 'qemu'
        || value.owner?.baseImage !== 'folia-soloist-clean-base.qcow2'
        || !record(value.runtimeFiles) || !record(value.owner.integrity)
        || !/^[a-f0-9]{128}$/.test(value.owner.integrity.baseImageSha512 || '')) throw fail('APPLIANCE_COMPONENT_INVALID');
    const inventory = componentInventory(root), declared = Object.keys(value.runtimeFiles), aliases = new Set();
    if (inventory.size !== declared.length) throw fail('APPLIANCE_COMPONENT_INVALID');
    for (const relative of declared) {
        if (!relativePath(relative) || !/^(qemu|ssh)\//.test(relative) || !inventory.has(relative) || aliases.has(relative.toLowerCase()))
            throw fail('APPLIANCE_COMPONENT_INVALID');
        aliases.add(relative.toLowerCase());
    }
    for (const [relative, expected] of Object.entries(value.runtimeFiles)) {
        if (!sha256(expected)) throw fail('APPLIANCE_COMPONENT_INVALID');
        fileHash(within(relative), 'sha256', expected);
    }
    for (const entry of ['qemu/qemu-system-x86_64.exe', 'qemu/qemu-img.exe', 'ssh/ssh.exe'])
        if (!value.runtimeFiles[entry]) throw fail('APPLIANCE_COMPONENT_INVALID');
    if (value.owner.integrity?.qemuSha256 !== value.runtimeFiles['qemu/qemu-system-x86_64.exe']
        || value.owner.integrity?.qemuImgSha256 !== value.runtimeFiles['qemu/qemu-img.exe']) throw fail('APPLIANCE_COMPONENT_INVALID');
    const baseImage = within(value.owner.baseImage);
    if (verifyBase) fileHash(baseImage, 'sha512', value.owner.integrity.baseImageSha512);
    const after = componentInventory(root);
    if (after.size !== inventory.size || [...inventory].some(([relative, info]) => !after.has(relative) || !sameFile(info, after.get(relative))))
        throw fail('APPLIANCE_COMPONENT_CHANGED');
    return { ownerOptions: { runtimeDirectory: within('qemu', true), baseImage, integrity: Object.freeze({
        baseImageSha512: value.owner.integrity.baseImageSha512, qemuSha256: value.owner.integrity.qemuSha256,
        qemuImgSha256: value.owner.integrity.qemuImgSha256 }) },
        sshExecutablePath: within('ssh/ssh.exe'), sshExecutableSha256: value.runtimeFiles['ssh/ssh.exe'],
        codecDiagnostics: value.capabilities?.codecDiagnostics === true };
}
function readComponent(options) {
    try { return loadComponent(options, true); }
    catch (error) { throw error.code === 'INVALID_REQUEST' || error.code?.startsWith('APPLIANCE_') ? error : fail('APPLIANCE_COMPONENT_UNAVAILABLE'); }
}
function createApplicationSoloist({ app, safeStorage, environment = process.env, createComposition = createSoloistApplianceComposition }) {
    if (process.type === 'renderer') throw fail('INVALID_REQUEST');
    const directory = path.join(app.getPath('userData'), 'spotify', 'soloist-appliance');
    const componentDirectory = !app.isPackaged && environment.FOLIA_SOLOIST_COMPONENT_DIRECTORY
        ? path.resolve(environment.FOLIA_SOLOIST_COMPONENT_DIRECTORY) : path.join(process.resourcesPath || '', 'spotify-soloist-appliance');
    let component, componentPin;
    const resolveComponent = (refresh = false) => {
        if (!component || refresh) {
            let manifestSha256 = !app.isPackaged ? environment.FOLIA_SOLOIST_COMPONENT_MANIFEST_SHA256 : undefined;
            if (app.isPackaged) {
                try { manifestSha256 = require('./soloist-appliance-approved.json').manifestSha256; }
                catch { throw fail('APPLIANCE_COMPONENT_UNAVAILABLE'); }
            }
            if (componentPin && componentPin !== manifestSha256) throw fail('APPLIANCE_COMPONENT_CHANGED');
            try {
                const resolved = loadComponent({ directory: componentDirectory, manifestSha256, packaged: app.isPackaged }, !component);
                if (component && (component.ownerOptions.runtimeDirectory !== resolved.ownerOptions.runtimeDirectory
                    || component.ownerOptions.baseImage !== resolved.ownerOptions.baseImage || component.sshExecutablePath !== resolved.sshExecutablePath))
                    throw fail('APPLIANCE_COMPONENT_CHANGED');
                component = resolved; componentPin = manifestSha256;
            }
            catch (error) { throw error.code?.startsWith('APPLIANCE_') ? error : fail('APPLIANCE_COMPONENT_UNAVAILABLE'); }
        }
        return component;
    };
    const vault = createSoloistApplianceSecrets({ directory, safeStorage });
    let composition, disposed = false, lastCode;
    const actual = options => {
        if (disposed) throw fail('APPLIANCE_CLOSED');
        if (options?.signal?.aborted) throw fail('CANCELLED');
        if (!composition) {
            try {
                const resolved = resolveComponent();
                composition = createComposition({ directory, safeStorage,
                    diagnostics: resolved.codecDiagnostics,
                    ownerOptions: { ...resolved.ownerOptions, dataDirectory: path.join(directory, 'appliance-data') },
                    sshExecutablePath: resolved.sshExecutablePath, sshExecutableSha256: resolved.sshExecutableSha256,
                    // Refresh dependencies immediately before each lazy owner is
                    // constructed. Owner.start separately rechecks the disk and EXEs.
                    createOwner: options => { if (disposed) throw fail('APPLIANCE_CLOSED'); resolveComponent(true); return createSoloistApplianceOwner(options); },
                    downloadOfficialAsset: downloadSoloistOfficialAsset });
                lastCode = undefined;
            } catch (error) { lastCode = error.code || 'APPLIANCE_COMPONENT_UNAVAILABLE'; throw error; }
        }
        return composition;
    };
    const publicStatus = async () => {
        if (composition) return composition.publicStatus();
        const { hasKey } = await vault.publicStatus();
        return { hasKey, state: lastCode ? 'failed' : hasKey ? 'stopped' : 'unconfigured', ...(lastCode ? { code: lastCode } : {}) };
    };
    const configuration = Object.freeze({ deviceName: 'Folia Spotify',
        ownedSoloist: { readFresh: options => actual(options).getSoloistConfiguration().ownedSoloist.readFresh(options),
            seekOwnedPaused: (request, options) => actual(options).getSoloistConfiguration().ownedSoloist.seekOwnedPaused(request, options),
            markCodecDiagnostics: (request, options) => actual(options).getSoloistConfiguration().ownedSoloist.markCodecDiagnostics(request, options),
            readCodecDiagnosticsSince: (request, options) => actual(options).getSoloistConfiguration().ownedSoloist.readCodecDiagnosticsSince(request, options) },
        applyQuality: (quality, options) => {
            if (disposed) throw fail('APPLIANCE_CLOSED');
            if (options?.signal?.aborted) throw fail('CANCELLED');
            if (composition) return composition.getSoloistConfiguration().applyQuality(quality, options);
            // A new profile must first complete its own playback setup. Check
            // that prerequisite before validating or starting optional runtime files.
            return vault.publicStatus().then(({ hasKey }) => {
                if (disposed) throw fail('APPLIANCE_CLOSED');
                if (options?.signal?.aborted) throw fail('CANCELLED');
                if (!hasKey) throw fail('SOLOIST_KEY_REQUIRED');
                return actual(options).getSoloistConfiguration().applyQuality(quality, options);
            });
        },
        resolveControlConfiguration: options => actual(options).getSoloistConfiguration().resolveControlConfiguration(options) });
    return {
        publicStatus,
        async saveKey(key) { if (disposed) throw fail('APPLIANCE_CLOSED');
            if (composition) return composition.saveKey(key); await vault.saveKey(key); lastCode = undefined; return publicStatus(); },
        startSetup: options => actual(options).startSetup(options),
        stopSetup: () => composition?.stopSetup(), logout: () => composition?.logout(),
        getSoloistConfiguration: () => { if (disposed) throw fail('APPLIANCE_CLOSED'); return configuration; },
        async close() { disposed = true; await composition?.close(); },
    };
}
module.exports = { createApplicationSoloist, readComponent };
