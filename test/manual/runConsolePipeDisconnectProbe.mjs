import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Deliberately disconnect stdout; Electron must continue and finish rather than open fatal dialogs.
const root = path.resolve(import.meta.dirname, '../..');
const marker = path.resolve(root, `../artifacts/native-streaming-20261002/console-completed-${Date.now()}.txt`);
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'test/manual/consolePipeDisconnectProbe.cjs'), marker], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '', disconnected = false;
child.stderr.on('data', chunk => { stderr += chunk; });
child.stdout.once('data', () => { disconnected = true; child.stdout.destroy(); child.stdin.end('continue'); });
const timer = setTimeout(() => child.kill(), 15000);
try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    const report = { at: new Date().toISOString(), disconnected, exitCode,
        completed: (await fs.readFile(marker, 'utf8').catch(() => '')) === 'work-completed', uncaughtPipeError: /Uncaught|EPIPE/.test(stderr) };
    await fs.writeFile(path.resolve(root, `../artifacts/native-streaming-20261002/console-disconnect-${Date.now()}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    assert.equal(exitCode, 0); assert.equal(report.completed, true); assert.equal(report.uncaughtPipeError, false);
} finally { clearTimeout(timer); }
