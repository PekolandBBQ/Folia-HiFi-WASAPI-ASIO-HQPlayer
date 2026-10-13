import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Electron is a GUI executable on Windows: retain its lifetime explicitly and
// send logs to a file, so a terminal/tool closing cannot break the app's console.
const root = path.resolve(import.meta.dirname, '../..');
const directory = path.resolve(root, '../artifacts/native-streaming-20261002');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `service-console-${Date.now()}.log`);
const descriptor = fs.openSync(file, 'a');
const executable = createRequire(import.meta.url)('electron');
const child = spawn(executable, [path.join(root, 'test/manual/nativeStreamServiceProbe.cjs')], {
    cwd: root, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
});
fs.closeSync(descriptor);
console.log(`Service probe logs: ${file}`);
const timeout = setTimeout(() => child.kill(), 320000);
try {
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    // The full progress log is preserved on disk; keep terminal output compact.
    console.log(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.startsWith('{"backend"') || line.endsWith('.json')).join('\n'));
    process.exitCode = code;
} finally { clearTimeout(timeout); }
