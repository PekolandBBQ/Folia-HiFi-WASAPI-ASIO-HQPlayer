import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { installConsolePipeGuard } = createRequire(import.meta.url)('../../../electron/debug/consolePipeGuard.cjs');

describe('closed launcher console pipe', () => {
    it('retires only a broken console sink, reports it once and restores on cleanup', () => {
        const stream = Object.assign(new EventEmitter(), { write: vi.fn(() => { throw Object.assign(new Error('pipe'), { code: 'EPIPE' }); }) });
        const original = stream.write, notice = vi.fn();
        const cleanup = installConsolePipeGuard({ streams: [stream], onBrokenPipe: notice });
        expect(stream.write()).toBe(false);
        expect(stream.write()).toBe(false);
        stream.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' }));
        expect(original).toHaveBeenCalledTimes(1); expect(notice).toHaveBeenCalledTimes(1);
        cleanup(); expect(stream.write).toBe(original); expect(stream.listenerCount('error')).toBe(0);
    });
    it('does not suppress unrelated console I/O errors', () => {
        const failure = Object.assign(new Error('bad descriptor'), { code: 'EBADF' });
        const stream = Object.assign(new EventEmitter(), { write: () => { throw failure; } });
        const cleanup = installConsolePipeGuard({ streams: [stream] });
        try {
            expect(() => stream.write()).toThrow(failure);
            expect(() => stream.emit('error', failure)).toThrow(failure);
        } finally { cleanup(); }
    });
    it('survives actual stdout disconnect while later playback work continues', async () => {
        const modulePath = createRequire(import.meta.url).resolve('../../../electron/debug/consolePipeGuard.cjs');
        const code = `require(${JSON.stringify(modulePath)}).installConsolePipeGuard(); process.stdout.write('ready'); process.stdin.once('data', () => { for (let i=0; i<20; i++) console.info('progress', i); setTimeout(() => { process.stderr.write('work-completed'); process.exit(0); }, 50); });`;
        const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.once('data', () => { child.stdout.destroy(); child.stdin.end('continue'); });
        const exit = await new Promise(resolve => child.once('exit', resolve));
        expect(exit).toBe(0); expect(stderr).toBe('work-completed');
    });
    it('survives an actual stderr disconnect while the independent stdout sink remains usable', async () => {
        const modulePath = createRequire(import.meta.url).resolve('../../../electron/debug/consolePipeGuard.cjs');
        const code = `require(${JSON.stringify(modulePath)}).installConsolePipeGuard(); process.stderr.write('ready'); process.stdin.once('data', () => { for (let i=0; i<20; i++) { console.warn('diagnostic', i); console.error('operation', i); } setTimeout(() => { process.stdout.write('work-completed'); process.exit(0); }, 50); });`;
        const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.once('data', () => { child.stderr.destroy(); child.stdin.end('continue'); });
        const exit = await new Promise(resolve => child.once('exit', resolve));
        expect(exit).toBe(0); expect(stdout).toBe('work-completed');
    });
    it('continues startup and asynchronous progress after the launcher disconnects both console pipes', async () => {
        const modulePath = createRequire(import.meta.url).resolve('../../../electron/debug/consolePipeGuard.cjs');
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-console-disconnect-'));
        const marker = path.join(directory, 'completed.txt');
        const code = `const fs=require('node:fs'); require(${JSON.stringify(modulePath)}).installConsolePipeGuard(); console.log('ready'); process.stdin.once('data', () => { console.log('startup'); console.error('startup diagnostic'); setTimeout(() => { for (let i=0; i<20; i++) { console.info('progress',i); console.warn('progress diagnostic',i); } setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)},'work-completed'); process.exit(0); },50); },25); });`;
        const child = spawn(process.execPath, ['-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.once('data', () => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.end('continue'); });
        try {
            const exit = await new Promise(resolve => child.once('exit', resolve));
            expect(exit).toBe(0); expect(await fs.readFile(marker, 'utf8')).toBe('work-completed');
        } finally { child.kill(); await fs.rm(directory, { recursive: true, force: true }); }
    });
});
