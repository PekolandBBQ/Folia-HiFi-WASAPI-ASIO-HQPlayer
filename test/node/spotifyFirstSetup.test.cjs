'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os'), path = require('node:path');
const { configureAssets } = require('../../electron/spotify/configureAssets.cjs');
const { runCli } = require('../../electron/spotify/configureCli.cjs');
const { digest } = require('../../electron/spotify/componentPackage.cjs');
// Synthetic source layouts isolate resumability; real vendor CLI runs are recorded separately.
async function fixture(t, layout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-first-setup-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('folia-first-setup-'));
    await fs.rm(root, {recursive:true,force:true});
  });
  const source = path.join(root, 'source'), directory = path.join(root, 'assets');
  await fs.mkdir(path.join(source,'Apps'), {recursive:true});
  await fs.writeFile(path.join(source,'Apps/xpui.spa'),'stock');
  await fs.writeFile(path.join(source,'Spotify.exe'),'binary');
  await fs.writeFile(path.join(source,'v8_context_snapshot.bin'),'snapshot');
  const prefs = path.join(root,'prefs');
  await fs.writeFile(prefs,'app.last-launched-version = "1.2.fixture"\n');
  const wrapper = 'vendor wrapper', bundle = {version:'0.1.0-preview.4',spicetify:{wrapperSha256:digest(Buffer.from(wrapper))}};
  const target = {id:layout+'-fixture', layout, exe:path.join(source,'Spotify.exe'), prefs};
  const calls=[];
  const execute = async (_exe,args,env) => {
    calls.push(args);
    if (args.at(-1)==='apply') {
      const apps = layout==='store'?path.join(env.SPICETIFY_CONFIG,'AppX'):path.join(env.USERPROFILE,'spotify/Apps');
      await fs.mkdir(path.join(apps,'xpui/helper'),{recursive:true});
      await fs.mkdir(path.join(apps,'xpui/extensions'),{recursive:true});
      await fs.writeFile(path.join(apps,'xpui/index.html'),'<script src="helper/spicetifyWrapper.js"></script><script src="extensions/folia-live-bridge.js"></script></body>');
      await fs.writeFile(path.join(apps,'xpui/helper/spicetifyWrapper.js'),wrapper);
      await fs.writeFile(path.join(apps,'xpui/xpui-snapshot.js'),'script');
      await fs.writeFile(path.join(apps,'xpui/xpui-modules.js'),'modules');
    }
  };
  return {root, source,directory,calls,options:{directory,target,cli:root,extension:'session one',bundle,execute}};
}
for (const layout of ['store','desktop']) test(layout+' fresh setup prepares binaries, quiet CLI and correct destination; resume does not backup again', async t=>{
  const f = await fixture(t,layout);
  const apps = await configureAssets(f.options);
  assert.equal(apps,path.join(f.directory,layout==='store'?'roaming/spicetify/AppX':'spotify/Apps'));
  assert.deepEqual(f.calls,[['--no-restart','--quiet','backup'],['--no-restart','--quiet','apply']]);
  assert.equal(await fs.readFile(path.join(f.directory,'spotify/Spotify.exe'),'utf8'),'binary');
  assert.equal(await fs.readFile(path.join(f.directory,'spotify/v8_context_snapshot.bin'),'utf8'),'snapshot');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,'configuration.json'),'utf8')).stage,'configured');
  await configureAssets({...f.options,extension:'session two'});
  assert.equal(f.calls.length,2);
  assert.equal(await fs.readFile(path.join(apps,'xpui/extensions/folia-live-bridge.js'),'utf8'),'session two');
  assert.equal(await fs.readFile(path.join(f.source,'Apps/xpui.spa'),'utf8'),'stock');
});
test('a stopped backup receipt remains unchanged and invokes no vendor command',async t=>{
  const f=await fixture(t,'store');
  await fs.mkdir(f.directory);
  const text=JSON.stringify({schema:1,installation:f.options.target.id,bundleVersion:f.options.bundle.version,stage:'backup-started',backupAttempted:true});
  const receipt=path.join(f.directory,'configuration.json');
  await fs.writeFile(receipt,text);
  await assert.rejects(configureAssets(f.options),{code:'SPOTIFY_BACKUP_REVIEW_REQUIRED'});
  assert.equal(await fs.readFile(receipt,'utf8'),text); assert.equal(f.calls.length,0);
});
test('missing program binary fails before the first backup',async t=>{
  const f=await fixture(t,'desktop'); await fs.unlink(path.join(f.source,'Spotify.exe'));
  await assert.rejects(configureAssets(f.options),{code:'SPOTIFY_ASSET_BINARY_MISSING'}); assert.equal(f.calls.length,0);
});
test('CLI stdin is closed and stdout failure facts survive',async t=>{
  const f=await fixture(t,'desktop'), log=path.join(f.root,'steps.jsonl');
  await runCli(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>console.log('EOF'));"],process.env,log);
  assert.match(JSON.parse((await fs.readFile(log,'utf8')).trim()).stdout,/EOF/);
  await assert.rejects(runCli(process.execPath,['-e',"console.error('vendor failed');process.exit(7)"],process.env,log),{code:'SPOTIFY_CONFIGURE_CLI_FAILED'});
  const records=(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records[1].exitCode,7);assert.match(records[1].stderr,/vendor failed/);
});

for(const layout of ['store','desktop'])test(layout+' fresh client generation preserves old files and records the new client build',async t=>{
 const f=await fixture(t,layout);
 f.options.target.binaryVersion='1.3.4.258';await configureAssets(f.options);
 const oldReceipt=await fs.readFile(path.join(f.directory,'configuration.json'),'utf8');
 const directory=path.join(f.root,'client-1.3.5');
 const options={...f.options,directory,target:{...f.options.target,binaryVersion:'1.3.5.3058'}};
 const apps=await configureAssets(options);
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'configuration.json'),'utf8')).spotifyVersion,'1.3.5.3058');
 assert.equal((await require('../../electron/spotify/resourceVersion.cjs').resourceVersion(apps,options.target)).state,'current');
 const before=f.calls.length;await configureAssets(options);assert.equal(f.calls.length,before);
 assert.equal(await fs.readFile(path.join(f.directory,'configuration.json'),'utf8'),oldReceipt);
});
