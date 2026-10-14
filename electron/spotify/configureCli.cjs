'use strict';
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { fail } = require('./componentPackage.cjs');

// electron/spotify/configureCli.cjs — noninteractive fixed-version CLI calls with retained failure facts.
async function runCli(exe, args, env, diagnosticsFile) {
  let facts;
  await new Promise((resolve, reject) => {
    const child = execFile(exe, args, { env, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const clean = text => String(text || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/https?:\/\/\S+/g, '[URL]').slice(-8192);
      facts = { at: new Date().toISOString(), command: args.at(-1), ok: !error,
        exitCode: error?.code ?? 0, signal: error?.signal ?? null, killed: Boolean(error?.killed), stdout: clean(stdout), stderr: clean(stderr) };
      if (error) reject(fail(error.killed ? 'SPOTIFY_CONFIGURE_CLI_TIMEOUT' : 'SPOTIFY_CONFIGURE_CLI_FAILED'));
      else resolve();
    });
    // --quiet handles the known Store confirmation. EOF also prevents an unexpected prompt from hanging.
    child.stdin?.end();
  }).finally(async () => {
    if (diagnosticsFile && facts) await fs.appendFile(diagnosticsFile, JSON.stringify(facts) + '\n').catch(() => {});
  });
}
module.exports = { runCli };
