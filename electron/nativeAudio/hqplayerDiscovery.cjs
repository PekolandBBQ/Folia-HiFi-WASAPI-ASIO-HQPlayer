const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { audioError } = require('./errors.cjs');

// electron/nativeAudio/hqplayerDiscovery.cjs — multiple Desktop versions and an explicit user-selected executable.
const execFileAsync = promisify(execFile);
const isDesktopName = value => /^HQPlayer(?:\d+)?Desktop\.exe$/i.test(path.basename(value || ''));
async function validExecutable(value) {
    return typeof value === 'string' && path.isAbsolute(value) && !value.startsWith('\\\\') && isDesktopName(value)
        && await fs.stat(value).then(stat => stat.isFile(), () => false);
}
async function discoverHQPlayers({ exec = execFileAsync, roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) } = {}) {
    const candidates = [];
    for (const root of roots) for (const base of [root, path.join(root, 'Signalyst')]) {
        const folders = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
        for (const folder of folders.filter(item => item.isDirectory() && /^HQPlayer.*Desktop/i.test(item.name))) {
            const directory = path.join(base, folder.name);
            const files = await fs.readdir(directory).catch(() => []);
            candidates.push(...files.filter(isDesktopName).map(name => path.join(directory, name)));
        }
    }
    const script = [
        "$roots=@((Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))",
        "$shell=New-Object -ComObject WScript.Shell",
        "Get-ChildItem -LiteralPath $roots -Recurse -Filter 'HQPlayer*Desktop*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {$target=$shell.CreateShortcut($_.FullName).TargetPath;if($target){[Console]::Out.WriteLine($target)}}",
    ].join(';');
    try {
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
        candidates.push(...stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
    } catch {}
    const unique = new Map();
    for (const candidate of candidates) if (await validExecutable(candidate)) unique.set(candidate.toLowerCase(), candidate);
    const version = value => Number(path.basename(value).match(/HQPlayer(\d+)/i)?.[1] || 0);
    return [...unique.values()].sort((a, b) => version(b) - version(a) || a.localeCompare(b));
}
async function findHQPlayerExecutable(options) { return (await discoverHQPlayers(options))[0] || null; }

function createExecutablePreference(configPath) {
    let selected = null, loading;
    async function read() {
        loading ||= (async () => {
            if (configPath) try { const value = JSON.parse(await fs.readFile(configPath, 'utf8')); selected = typeof value.executablePath === 'string' ? value.executablePath : null; } catch {}
        })();
        await loading;
        return selected;
    }
    async function set(value) {
        await read();
        if (value !== null && !await validExecutable(value)) throw audioError('HQPLAYER_PATH_INVALID', 'Choose an installed HQPlayer Desktop executable');
        if (configPath) {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(`${configPath}.tmp`, JSON.stringify({ executablePath: value }));
            await fs.rename(`${configPath}.tmp`, configPath);
        }
        selected = value;
    }
    return { read, set };
}
module.exports = { discoverHQPlayers, findHQPlayerExecutable, validExecutable, isDesktopName, createExecutablePreference };
