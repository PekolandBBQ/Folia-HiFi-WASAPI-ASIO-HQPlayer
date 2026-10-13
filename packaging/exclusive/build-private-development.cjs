'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const { PRIVATE_VERSION, ELECTRON_VERSION, BUILD_ID, sha256 } = require('./privateDevelopment.cjs');

// packaging/exclusive/build-private-development.cjs — Linux-only staging and NSIS compilation, never Windows execution.
const ROOT = path.resolve(__dirname, '../..');
const PINS = Object.freeze({
    electron: '7acfa0646793f912ff983c8db8c3a145dc18ee40fe3d11a01840fd59cb76e5a2',
    nsis: '56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4',
    ffmpeg: 'd28a1c5730520de13dfe947f39366032a77eee5c4ba7e78b63fd82e409294cfb',
    ffmpegSource: '32faba5ef67340d54724941eae1425580791195312a4fd13bf6f820a2818bf22',
    ffmpegBuildSource: 'a32170b29159186d4a30be9c45b95aebe09b6e823b71a6d369680725e7481b4d',
    nativeAudio: '0869d266271714d72655e3135e87de4a5c3e97aceb6cf8d2da4d2a1e5e826463',
    hqplayer: 'd4cc5fa0a34e426d53216cfe22f90e3efea3fa53aea492a1b274a77d3a49d82a',
    lock: '994e350af3168c38260d5dfa8d16c43c09b048ac80b9e63ad6ae4c65c47f7fbb',
});
const SOURCE_ENTRIES = ['dist', 'electron', 'shared', 'packaging/exclusive', 'docs/exclusive',
    'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'build/icon.png', 'build/miao.png',
    'build/trayTemplate.png', 'build/trayTemplate@2x.png', 'build/thumbar'];
const slash = value => value.split(path.sep).join('/');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function fileHash(file, algorithm = 'sha256', encoding = 'hex') {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular build input: ${file}`);
    const hash = crypto.createHash(algorithm), buffer = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, 'r');
    try { let count; while ((count = fs.readSync(fd, buffer))) hash.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); }
    return hash.digest(encoding);
}
function verifyHash(file, expected) {
    if (!path.isAbsolute(file || '') || !validHash(expected) || fileHash(file) !== expected)
        throw new Error(`Build input checksum mismatch: ${file}`);
}
function filesUnder(directory, relative = '') {
    const result = [];
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
        if (/[\x00-\x1f\x7f]/.test(name)) throw new Error('Control character in build path');
        const item = path.join(relative, name), info = fs.lstatSync(path.join(directory, item));
        if (info.isSymbolicLink()) throw new Error(`Symlink in build input: ${item}`);
        if (info.isDirectory()) result.push(...filesUnder(directory, item));
        else if (info.isFile()) result.push(slash(item));
        else throw new Error(`Unsupported build input: ${item}`);
    }
    return result;
}
function sourceFiles(root = ROOT) {
    const { SOURCE_FILES } = require(path.join(root, 'electron/debug/privatePreviewDiagnosticSchema.cjs'));
    const files = new Set();
    for (const entry of [...SOURCE_ENTRIES, ...SOURCE_FILES]) {
        const absolute = path.join(root, entry);
        if (!fs.existsSync(absolute)) {
            if (SOURCE_ENTRIES.includes(entry)) throw new Error(`Required build source is absent: ${entry}`);
            continue;
        }
        const info = fs.lstatSync(absolute);
        if (info.isSymbolicLink()) throw new Error(`Symlink in build source: ${entry}`);
        if (info.isDirectory()) for (const child of filesUnder(absolute)) files.add(`${entry}/${child}`);
        else files.add(entry);
    }
    return [...files].sort();
}
function createSourceFreeze(root = ROOT) {
    const hashes = Object.fromEntries(sourceFiles(root).map(file => [file, fileHash(path.join(root, file))]));
    return { schema: 1, version: PRIVATE_VERSION, purpose: 'private-development-only', sourceHashes: hashes };
}
function verifySourceFreeze(config, root = ROOT) {
    verifyHash(config.sourceFreezeFile, config.sourceFreezeSha256);
    const saved = JSON.parse(fs.readFileSync(config.sourceFreezeFile, 'utf8'));
    const current = createSourceFreeze(root);
    if (JSON.stringify(saved) !== JSON.stringify(current)) throw new Error('Sources changed after the supplied freeze');
    return current;
}

// npm supplies the installed production closure; copying never prunes or alters the working dependency tree.
function productionPackages(root = ROOT) {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const output = execFileSync(command, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 });
    return [...new Set(output.trim().split(/\r?\n/))].filter(file => path.resolve(file) !== root).map(file => {
        const relative = slash(path.relative(root, file));
        if (!relative.startsWith('node_modules/') || relative.split('/').includes('..') || !fs.statSync(file).isDirectory())
            throw new Error('Production dependency is outside the checkout');
        return relative;
    }).sort();
}
function includeProductionFile(packageRelative, fileRelative) {
    if (fileRelative.split('/').includes('node_modules')) return false;
    if (/(?:^|\/)@koromix\/koffi-/.test(packageRelative)
        && !packageRelative.endsWith('/@koromix/koffi-win32-x64')) return false;
    if (packageRelative.endsWith('/onnxruntime-node')) {
        const match = /^bin\/napi-v\d+\/(.+)$/.exec(fileRelative);
        if (match && !['win32', 'win32/x64'].includes(match[1]) && !match[1].startsWith('win32/x64/')) return false;
    }
    return true;
}
function copyProductionDependencies(root, appDirectory, packages) {
    for (const relative of packages) {
        if (!includeProductionFile(relative, '')) continue;
        const source = path.join(root, relative);
        fs.cpSync(source, path.join(appDirectory, relative), { recursive: true,
            filter: item => {
                const within = slash(path.relative(source, item));
                if (!includeProductionFile(relative, within)) return false;
                if (fs.lstatSync(item).isSymbolicLink()) throw new Error(`Symlink in production package: ${relative}/${within}`);
                return true;
            } });
    }
}
function validateKoffiArchive(archive, lock) {
    const locked = lock.packages['node_modules/@koromix/koffi-win32-x64'];
    if (locked?.version !== '3.3.1' || locked.resolved !== 'https://registry.npmjs.org/@koromix/koffi-win32-x64/-/koffi-win32-x64-3.3.1.tgz'
        || !/^sha512-[A-Za-z0-9+/]+=*$/.test(locked.integrity || '')
        || `sha512-${fileHash(archive, 'sha512', 'base64')}` !== locked.integrity)
        throw new Error('The Windows x64 Koffi archive does not match package-lock.json');
    return locked;
}
function extractKoffi(archive, destination) {
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    if (entries.some(file => !/^package\/[A-Za-z0-9_./-]+$/.test(file) || file.split('/').includes('..')))
        throw new Error('Unexpected Koffi package archive path');
    fs.mkdirSync(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
    filesUnder(destination);
    const metadata = JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8'));
    if (metadata.name !== '@koromix/koffi-win32-x64' || metadata.version !== '3.3.1'
        || !fs.existsSync(path.join(destination, 'win32_x64/koffi.node'))) throw new Error('Unexpected Koffi package contents');
}
function componentMetadata(archive, kind) {
    verifyHash(archive, PINS[kind]);
    const files = unzipSync(fs.readFileSync(archive));
    const info = JSON.parse(Buffer.from(files['component.json'] || []).toString('utf8'));
    const entry = kind === 'hqplayer' ? 'hqplayer-component.cjs' : 'folia-audio.exe';
    const expectedVersion = kind === 'hqplayer' ? '0.1.4-preview.3' : '0.1.3-preview.2';
    const allowed = kind === 'hqplayer' ? require('../../electron/hqplayer/archiveContract.cjs').HQPLAYER_ARCHIVE_FILE
        : /^[a-zA-Z0-9_.-]+\.(?:exe|txt|json)$/;
    if (info.version !== expectedVersion || info.protocolMajor !== 1 || !files[entry]
        || Object.keys(files).some(name => !allowed.test(name) || name.includes('..'))
        || (kind === 'hqplayer' && (info.id !== 'hqplayer' || info.entry !== entry))) throw new Error('Unexpected component archive');
    return { version: info.version, protocolMajor: 1, platform: 'win32-x64', sha256: PINS[kind],
        entrySha256: sha256(files[entry]), archive: `folia-${kind === 'nativeAudio' ? 'native-audio' : 'hqplayer'}-${info.version}-win32-x64.zip` };
}
function nsisQuote(value) {
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid NSIS path');
    return value.replace(/\$/g, '$$$$').replace(/"/g, '$\\"');
}
function payloadInclude(payload) {
    let directory;
    const lines = [];
    for (const relative of filesUnder(payload)) {
        const current = path.posix.dirname(relative);
        if (current !== directory) {
            lines.push(`SetOutPath "$INSTDIR${current === '.' ? '' : '\\' + nsisQuote(current.replace(/\//g, '\\'))}"`);
            directory = current;
        }
        lines.push(`File "/oname=${nsisQuote(path.posix.basename(relative))}" "${nsisQuote(path.join(payload, relative))}"`);
    }
    return lines.join('\n') + '\n';
}

function verifyInputs(config, root = ROOT) {
    verifyHash(path.join(root, 'package-lock.json'), PINS.lock);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    if (metadata.version !== '0.7.12' || lock.packages['node_modules/electron']?.version !== ELECTRON_VERSION)
        throw new Error('Private build base/Electron version changed');
    verifySourceFreeze(config, root);
    for (const [field, pin] of [['electronArchive', 'electron'], ['nsisArchive', 'nsis'],
        ['ffmpegSourceArchive', 'ffmpegSource'], ['ffmpegBuildSourceArchive', 'ffmpegBuildSource']]) verifyHash(config[field], PINS[pin]);
    verifyHash(path.join(config.ffmpegDirectory, 'ffmpeg.exe'), PINS.ffmpeg);
    validateKoffiArchive(config.koffiArchive, lock);
    const native = componentMetadata(config.nativeAudioArchive, 'nativeAudio');
    const hqplayer = componentMetadata(config.hqplayerArchive, 'hqplayer');
    if (!path.isAbsolute(config.soloistComponentDirectory || '') || !validHash(config.soloistManifestSha256))
        throw new Error('A verified private Soloist component and manifest pin are required');
    verifyHash(path.join(config.soloistComponentDirectory, 'component.manifest.json'), config.soloistManifestSha256);
    const manifest = JSON.parse(fs.readFileSync(path.join(config.soloistComponentDirectory, 'component.manifest.json'), 'utf8'));
    if (manifest.releaseReady !== false || manifest.soloist?.bundled !== false || manifest.soloist?.perUserOfficialDownload !== true)
        throw new Error('Private packaging requires the unapproved, account-free component state');
    require('../../electron/spotify/soloistApplication.cjs').readComponent({ directory: config.soloistComponentDirectory,
        manifestSha256: config.soloistManifestSha256, packaged: false });
    const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
    if (/\b(?:src|href)="\/(?:assets|runtime-config)/.test(html)) throw new Error('Build renderer with ELECTRON=true');
    return { metadata, lock, native, hqplayer };
}

// Only explicit --stage/--compile operations materialize a payload; callers must supply a frozen source manifest.
async function stage(config, root = ROOT) {
    const inputs = verifyInputs(config, root), output = path.resolve(config.outputDirectory);
    if (!path.isAbsolute(config.outputDirectory || '') || fs.existsSync(path.join(output, 'payload')))
        throw new Error('Choose a new absolute output directory; an existing payload is never overwritten');
    fs.mkdirSync(output, { recursive: true });
    const payload = path.join(output, 'payload'), electron = path.join(payload, 'electron'), app = path.join(payload, 'app');
    fs.mkdirSync(electron, { recursive: true }); fs.mkdirSync(app, { recursive: true });
    const { default: extractZip } = await import('@electron-internal/extract-zip');
    await extractZip(config.electronArchive, { dir: electron });
    if (!fs.existsSync(path.join(electron, 'resources/default_app.asar'))
        || fs.existsSync(path.join(electron, 'resources/app.asar')) || fs.existsSync(path.join(electron, 'resources/app')))
        throw new Error('Official Electron default-app layout is missing');
    const officialElectronSha256 = fileHash(path.join(electron, 'electron.exe'));
    const defaultAppSha256 = fileHash(path.join(electron, 'resources/default_app.asar'));
    for (const entry of ['dist', 'electron', 'shared', 'docs/exclusive', 'README.md', 'LICENSE', 'build/miao.png',
        'build/icon.png', 'build/trayTemplate.png', 'build/trayTemplate@2x.png', 'build/thumbar'])
        fs.cpSync(path.join(root, entry), path.join(app, entry), { recursive: true });
    for (const entry of ['privateDevelopment.cjs', 'private-development-entry.cjs'])
        fs.copyFileSync(path.join(__dirname, entry), path.join(app, 'electron', entry));
    const runtimePackage = { name: 'folia-private-development', version: PRIVATE_VERSION,
        productName: 'Folia HiFi Private Development', main: 'electron/private-development-entry.cjs',
        type: inputs.metadata.type || 'module', dependencies: inputs.metadata.dependencies };
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
    const packages = productionPackages(root);
    copyProductionDependencies(root, app, packages);
    extractKoffi(config.koffiArchive, path.join(app, 'node_modules/@koromix/koffi-win32-x64'));
    const resources = path.join(electron, 'resources');
    for (const entry of ['icon.png', 'trayTemplate.png', 'trayTemplate@2x.png'])
        fs.copyFileSync(path.join(root, 'build', entry), path.join(resources, entry));
    fs.cpSync(config.ffmpegDirectory, path.join(resources, 'ffmpeg-audio'), { recursive: true });
    const notices = path.join(resources, 'ffmpeg-audio/share/folia-ffmpeg');
    if (!fs.existsSync(notices) || filesUnder(notices).length === 0) throw new Error('FFmpeg redistribution notices are required');
    const sources = path.join(resources, 'ffmpeg-audio/source'); fs.mkdirSync(sources, { recursive: true });
    fs.copyFileSync(config.ffmpegSourceArchive, path.join(sources, 'ffmpeg-8.1.2.tar.gz'));
    fs.copyFileSync(config.ffmpegBuildSourceArchive, path.join(sources, 'folia-ffmpeg-build-226a670-source.zip'));
    const components = path.join(resources, 'exclusive-native-audio'); fs.mkdirSync(components, { recursive: true });
    fs.copyFileSync(config.nativeAudioArchive, path.join(components, inputs.native.archive));
    fs.copyFileSync(config.hqplayerArchive, path.join(components, inputs.hqplayer.archive));
    fs.writeFileSync(path.join(app, 'electron/private-development-approved.json'), JSON.stringify({ schema: 1,
        nativeAudio: [inputs.native], hqplayer: [inputs.hqplayer] }, null, 2) + '\n');
    fs.cpSync(config.soloistComponentDirectory, path.join(resources, 'spotify-soloist-appliance'), { recursive: true });
    const { SOURCE_FILES } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');
    const sourceHashes = Object.fromEntries(SOURCE_FILES.filter(file => fs.existsSync(path.join(root, file)))
        .map(file => [file, fileHash(path.join(root, file))]));
    const buildInfo = { appVersion: PRIVATE_VERSION, electronVersion: ELECTRON_VERSION, buildId: BUILD_ID,
        purpose: 'private-development-only', platform: 'win32', arch: 'x64', channel: 'private-preview',
        publicReleaseApproved: false, windowsExecutionTested: false, soloistManifestSha256: config.soloistManifestSha256, sourceHashes };
    fs.writeFileSync(path.join(app, 'electron/private-development-build.json'), JSON.stringify(buildInfo, null, 2) + '\n');
    verifySourceFreeze(config, root);
    verifyHash(path.join(electron, 'electron.exe'), officialElectronSha256);
    verifyHash(path.join(electron, 'resources/default_app.asar'), defaultAppSha256);
    require('../../electron/spotify/soloistApplication.cjs').readComponent({ directory: path.join(resources, 'spotify-soloist-appliance'),
        manifestSha256: config.soloistManifestSha256, packaged: false });
    const inventory = Object.fromEntries(filesUnder(payload).map(file => [file, fileHash(path.join(payload, file))]));
    const report = { schema: 1, version: PRIVATE_VERSION, purpose: 'private-development-only', windowsExecutionTested: false,
        publicReleaseApproved: false, electronArchiveSha256: PINS.electron, officialElectronSha256, defaultAppSha256,
        sourceFreezeSha256: config.sourceFreezeSha256, soloistManifestSha256: config.soloistManifestSha256,
        productionPackages: packages, payloadFiles: inventory };
    fs.writeFileSync(path.join(output, 'payload-manifest.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'payload.nsh'), payloadInclude(payload));
    return { output, payload, report };
}

async function main(args = process.argv.slice(2)) {
    const [operation, filename] = args;
    if (args.length !== 2 || !['--freeze', '--plan', '--stage', '--compile'].includes(operation) || !path.isAbsolute(filename || ''))
        throw new Error('Usage: node packaging/exclusive/build-private-development.cjs --freeze /absolute/freeze.json | --plan|--stage|--compile /absolute/inputs.json');
    if (operation === '--freeze') {
        fs.writeFileSync(filename, JSON.stringify(createSourceFreeze(), null, 2) + '\n', { flag: 'wx' });
        console.log(JSON.stringify({ sourceFreezeFile: filename, sourceFreezeSha256: fileHash(filename) })); return;
    }
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (operation === '--plan') {
        verifyInputs(config); console.log(JSON.stringify({ version: PRIVATE_VERSION, verified: true, compile: false })); return;
    }
    const result = await stage(config);
    if (operation === '--compile') {
        if (process.platform !== 'linux') throw new Error('Private installer compilation is restricted to the native Linux NSIS toolchain');
        const tools = path.join(result.output, 'nsis-toolchain'); fs.mkdirSync(tools);
        execFileSync('tar', ['-xzf', config.nsisArchive, '--strip-components=1', '-C', tools]);
        const executable = path.join(tools, 'makensis');
        const installer = path.join(result.output, `Folia-HiFi-Private-Development-${PRIVATE_VERSION}-win-x64-Setup.exe`);
        execFileSync(executable, [`-DOUTPUT_FILE=${installer}`, `-DPAYLOAD_INCLUDE=${path.join(result.output, 'payload.nsh')}`,
            path.join(__dirname, 'private-development-installer.nsi')], { stdio: 'inherit', env: { ...process.env, NSISDIR: tools } });
        fs.writeFileSync(path.join(result.output, 'installer-checksum.json'), JSON.stringify({ filename: path.basename(installer),
            sha256: fileHash(installer), bytes: fs.statSync(installer).size, windowsExecutionTested: false }, null, 2) + '\n');
        console.log(JSON.stringify({ installer, sha256: fileHash(installer), windowsExecutionTested: false }));
    } else console.log(JSON.stringify({ output: result.output, payloadFiles: Object.keys(result.report.payloadFiles).length, compiled: false }));
}

module.exports = { PINS, SOURCE_ENTRIES, fileHash, verifyHash, filesUnder, sourceFiles, createSourceFreeze, verifySourceFreeze,
    productionPackages, includeProductionFile, copyProductionDependencies, validateKoffiArchive, extractKoffi,
    componentMetadata, nsisQuote, payloadInclude, verifyInputs, stage, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
