'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, digest } = require('./componentPackage.cjs');
const defaultBundle = require('./componentBundle.json');
const { runCli } = require('./configureCli.cjs');
// Fresh users configure a private copy; existing CLI backups and Spotify Apps are read-only.
async function validateAssets(apps, bundle = defaultBundle) {
  const xpui = path.join(apps, 'xpui');
  const index = await fs.readFile(path.join(xpui, 'index.html'), 'utf8');
  if (!index.includes('helper/spicetifyWrapper.js') || !index.includes('extensions/folia-live-bridge.js')) throw fail('SPOTIFY_ASSET_REFERENCES_MISSING');
  const wrapper = await fs.readFile(path.join(xpui, 'helper/spicetifyWrapper.js'));
  if (digest(wrapper) !== bundle.spicetify.wrapperSha256) throw fail('SPOTIFY_COMPONENT_INTEGRITY');
  const candidates = ['xpui.js', 'xpui-snapshot.js'];
  const scripts = await Promise.all(candidates.map(name => fs.stat(path.join(xpui, name)).then(s => s.isFile()).catch(() => false)));
  if (!scripts.some(Boolean)) throw fail('SPOTIFY_ASSET_LAYOUT_UNSUPPORTED');
  if (scripts[1]) await fs.access(path.join(xpui, 'xpui-modules.js'));
  await fs.access(path.join(xpui, 'extensions/folia-live-bridge.js'));
}
async function configureExistingAssets(apps, extension, bundle = defaultBundle) {
  const xpui = path.join(apps, 'xpui'), indexFile = path.join(xpui, 'index.html');
  const index = await fs.readFile(indexFile, 'utf8');
  if (!index.includes('helper/spicetifyWrapper.js') || !index.includes('</body>')) throw fail('SPOTIFY_ASSET_LAYOUT_UNSUPPORTED');
  if (digest(await fs.readFile(path.join(xpui, 'helper/spicetifyWrapper.js'))) !== bundle.spicetify.wrapperSha256) throw fail('SPOTIFY_COMPONENT_INTEGRITY');
  await fs.mkdir(path.join(xpui, 'extensions'), { recursive: true });
  await fs.writeFile(path.join(xpui, 'extensions/folia-live-bridge.js'), extension);
  if (!index.includes('extensions/folia-live-bridge.js')) {
    await fs.writeFile(indexFile + '.folia.tmp', index.replace('</body>', '<script defer src="/extensions/folia-live-bridge.js"></script></body>'));
    await fs.rename(indexFile + '.folia.tmp', indexFile);
  }
  await validateAssets(apps, bundle);
}
async function configureAssets({ directory, target, cli, extension, execute = runCli, progress = async () => {}, bundle = defaultBundle }) {
  const record = path.join(directory, 'configuration.json'), config = path.join(directory, 'roaming/spicetify');
  const spotify = path.join(directory, 'spotify'), originalApps = path.join(spotify, 'Apps');
  const apps = target.layout === 'store' ? path.join(config, 'AppX') : originalApps;
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(record, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (receipt && (receipt.installation !== target.id || receipt.bundleVersion !== bundle.version)) throw fail('SPOTIFY_CONFIGURATION_VERSION_CHANGED');
  const save = async stage => { receipt.stage = stage; await fs.writeFile(record + '.tmp', JSON.stringify(receipt)); await fs.rename(record + '.tmp', record); await progress(stage); };
  if (!receipt) {
    // Do not adopt an unknown partially created directory as a clean first install.
    try { await fs.mkdir(directory); } catch (e) { if (e.code === 'EEXIST') throw fail('SPOTIFY_CONFIGURATION_REVIEW_REQUIRED'); throw e; }
    receipt = { schema: 1, installation: target.id, bundleVersion: bundle.version, stage: 'created', backupAttempted: false };
    await save('created');
  }
  if (receipt.stage === 'created') {
    if (!target.prefs) throw fail('SPOTIFY_LOGIN_REQUIRED');
    const prefs = await fs.readFile(target.prefs, 'utf8').catch(() => { throw fail('SPOTIFY_LOGIN_REQUIRED'); });
    if (!/^app\.last-launched-version\s*=/m.test(prefs)) throw fail('SPOTIFY_LOGIN_REQUIRED');
    const installation = path.dirname(target.exe);
    await fs.cp(path.join(installation, 'Apps'), originalApps, { recursive: true, errorOnExist: true, force: false });
    // Spicetify reads the release binary and V8 snapshot while preprocessing the copied assets.
    const files = await fs.readdir(installation);
    const binaries = files.filter(name => /^spotify\.(exe|dll)$/i.test(name));
    if (!binaries.length) throw fail('SPOTIFY_ASSET_BINARY_MISSING');
    for (const name of files.filter(name => /^spotify\.(exe|dll)$/i.test(name) || /^v8_context_snapshot.*\.bin$/i.test(name))) {
      await fs.copyFile(path.join(installation, name), path.join(spotify, name), require('node:fs').constants.COPYFILE_EXCL);
    }
    await fs.mkdir(path.join(config, 'Extensions'), { recursive: true });
    await fs.writeFile(path.join(config, 'Extensions/folia-live-bridge.js'), extension);
    const ini = `[Setting]\nspotify_path = ${spotify}\nprefs_path = ${target.prefs}\ninject_theme_js = 0\ninject_css = 0\nreplace_colors = 0\noverwrite_assets = 0\ncheck_spicetify_update = 0\nalways_enable_devtools = 0\n[Preprocesses]\ndisable_sentry = 0\ndisable_ui_logging = 0\nremove_rtl_rule = 0\nexpose_apis = 1\n[AdditionalOptions]\nextensions = folia-live-bridge.js\ncustom_apps =\nsidebar_config = 0\nhome_config = 0\nexperimental_features = 0\n[Patch]\n[Backup]\nversion =\nwith =\n`;
    await fs.writeFile(path.join(config, 'config-xpui.ini'), ini, { flag: 'wx' });
    await save('copied');
  }
  const env = { ...process.env, SPICETIFY_CONFIG: config, APPDATA: path.join(directory, 'roaming'), USERPROFILE: directory };
  delete env.SPICETIFY_STATE;
  if (receipt.stage === 'copied') {
    receipt.backupAttempted = true; await save('backup-started');
    await execute(path.join(cli, 'spicetify.exe'), ['--no-restart', '--quiet', 'backup'], env, path.join(directory, 'cli-steps.jsonl'));
    await save('backup-complete');
  }
  if (receipt.stage === 'backup-started') throw fail('SPOTIFY_BACKUP_REVIEW_REQUIRED');
  if (receipt.stage === 'backup-complete') {
    await save('apply-started');
    await execute(path.join(cli, 'spicetify.exe'), ['--no-restart', '--quiet', 'apply'], env, path.join(directory, 'cli-steps.jsonl'));
    await save('applied');
  }
  if (receipt.stage === 'apply-started') throw fail('SPOTIFY_APPLY_REVIEW_REQUIRED');
  // Refresh only the Folia-owned session extension. Never re-run backup/apply on resume.
  await fs.writeFile(path.join(apps, 'xpui/extensions/folia-live-bridge.js'), extension);
  await validateAssets(apps, bundle); await save('configured');
  return apps;
}
module.exports = { configureAssets, configureExistingAssets, validateAssets };
