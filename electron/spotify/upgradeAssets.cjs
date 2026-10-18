'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail } = require('./componentPackage.cjs');
const { runCli } = require('./configureCli.cjs');
const { validateAssets } = require('./configureAssets.cjs');
// Upgrade a Folia-owned resource copy using its retained backup; the original tree is never modified.
async function findReceipt(apps) {
 let directory = path.resolve(apps);
 for (let index = 0; index < 5; index++, directory = path.dirname(directory)) {
  try { const receipt = JSON.parse(await fs.readFile(path.join(directory, 'configuration.json'), 'utf8')); return { directory, receipt }; }
  catch (error) { if (error.code !== 'ENOENT') throw fail('SPOTIFY_COMPONENT_RECEIPT_UNREADABLE'); }
 }
 return null;
}
async function upgradeAssets({ apps, assetDirectory, target, cli, extension, bundle, execute = runCli }) {
 const previous = await findReceipt(apps);
 if (!previous || previous.receipt.installation !== target.id) return null;
 if ((await require('./resourceVersion.cjs').resourceVersion(apps,target)).state === 'mismatch') return null;
 if (!['backup-complete','applied','configured'].includes(previous.receipt.stage)) throw fail('SPOTIFY_BACKUP_REVIEW_REQUIRED');
 const oldConfig = path.join(previous.directory, 'roaming/spicetify');
 const backup = await fs.readdir(path.join(oldConfig, 'Backup')).catch(() => []);
 if (!backup.length) throw fail('SPOTIFY_BACKUP_MISSING');
 const directory = path.join(assetDirectory, bundle.version + '-upgrade-' + randomUUID());
 await fs.cp(previous.directory, directory, { recursive: true, errorOnExist: true, force: false });
 const config = path.join(directory, 'roaming/spicetify'), iniFile = path.join(config, 'config-xpui.ini');
 const ini = (await fs.readFile(iniFile, 'utf8')).split(previous.directory).join(directory);
 await fs.writeFile(iniFile, ini);
 await fs.writeFile(path.join(config, 'Extensions/folia-live-bridge.js'), extension);
 const env = { ...process.env, SPICETIFY_CONFIG: config, APPDATA: path.join(directory, 'roaming'), USERPROFILE: directory };
 delete env.SPICETIFY_STATE;
 await fs.writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ ...previous.receipt, bundleVersion: bundle.version, stage: 'apply-started', upgradedFrom: previous.directory }));
 await execute(path.join(cli, 'spicetify.exe'), ['--no-restart','--quiet','apply'], env, path.join(directory,'cli-steps.jsonl'));
 const result = target.layout === 'store' ? path.join(config, 'AppX') : path.join(directory, 'spotify/Apps');
 await validateAssets(result, bundle);
 await fs.writeFile(path.join(directory, 'configuration.json'), JSON.stringify({ ...previous.receipt, bundleVersion: bundle.version, stage: 'configured', upgradedFrom: previous.directory }));
 return result;
}
module.exports = { upgradeAssets, findReceipt };
