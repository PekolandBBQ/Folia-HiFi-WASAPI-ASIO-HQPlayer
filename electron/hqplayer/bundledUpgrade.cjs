const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const { HQPLAYER_ARCHIVE_FILE } = require('./archiveContract.cjs');

// electron/hqplayer/bundledUpgrade.cjs — atomic fork upgrade with one rollback, without touching settings or backups.
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const folder = release => `${release.version}-${release.sha256.slice(0,12)}`;
function pointer(directory, name) {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
function prune(directory, releases) {
    const kept = new Set(['active.json','previous.json','inactive.json'].map(name=>pointer(directory,name)?.archiveSha256).filter(Boolean));
    const result = {removed:[],deferred:[]};
    for (const release of releases) {
        if (kept.has(release.sha256)) continue;
        const target = path.resolve(directory, folder(release));
        if (path.dirname(target)!==path.resolve(directory)) throw Error('Invalid HQPlayer cleanup target');
        let stat; try { stat=fs.lstatSync(target); } catch(error) { if(error.code==='ENOENT')continue;throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        try { fs.rmSync(target,{recursive:true,force:true});result.removed.push(release.version); }
        catch(error) { if(!['EBUSY','EPERM','EACCES'].includes(error.code))throw error;result.deferred.push(release.version); }
    }
    return result;
}
function installBundledHQPlayer({directory,resources,releases}) {
    const approved=releases[0], previous=pointer(directory,'active.json');
    if (!approved) throw Error('No bundled HQPlayer component');
    if (pointer(directory,'inactive.json')) return {state:'disabled'};
    if (previous && !releases.some(item=>item.sha256===previous.archiveSha256)) return {state:'unknown-preserved'};
    if (previous?.archiveSha256===approved.sha256) return {state:'current',...prune(directory,releases)};
    const archive=fs.readFileSync(path.join(resources,approved.archive));
    const files=unzipSync(archive),info=JSON.parse(Buffer.from(files['component.json']||[]).toString());
    if(digest(archive)!==approved.sha256||info.id!=='hqplayer'||info.version!==approved.version||info.protocolMajor!==1
      ||!files['hqplayer-component.cjs']||digest(files['hqplayer-component.cjs'])!==approved.entrySha256)
        throw Error('HQPlayer manifest integrity failed');
    for(const name of Object.keys(files))if(!HQPLAYER_ARCHIVE_FILE.test(name))throw Error('Unexpected HQPlayer archive entry');
    fs.mkdirSync(directory,{recursive:true});
    const destination=path.join(directory,folder(approved));
    if(fs.existsSync(destination)) {
        if(digest(fs.readFileSync(path.join(destination,'hqplayer-component.cjs')))!==approved.entrySha256)
            throw Error('Existing HQPlayer component entry integrity failed');
    } else {
        const staging=fs.mkdtempSync(path.join(directory,'.bundled-'));
        try {for(const [name,data]of Object.entries(files))fs.writeFileSync(path.join(staging,name),data);fs.renameSync(staging,destination);}
        finally {if(fs.existsSync(staging)){if(path.dirname(path.resolve(staging))!==path.resolve(directory))throw Error('Invalid staging target');fs.rmSync(staging,{recursive:true,force:true});}}
    }
    if(previous) {
        const receipts=path.join(directory,'upgrade-receipts');fs.mkdirSync(receipts,{recursive:true});
        const receipt=path.join(receipts,`${previous.archiveSha256}.json`);
        if(!fs.existsSync(receipt))fs.writeFileSync(receipt,JSON.stringify({active:previous,previous:pointer(directory,'previous.json')}));
        fs.writeFileSync(path.join(directory,'previous.json'),JSON.stringify(previous));
    }
    fs.writeFileSync(path.join(directory,'active.json.tmp'),JSON.stringify({archiveSha256:approved.sha256,executableSha256:approved.entrySha256}));
    fs.renameSync(path.join(directory,'active.json.tmp'),path.join(directory,'active.json'));
    const result={state:previous?'upgraded':'installed',version:approved.version,...prune(directory,releases)};
    console.info('[HQPlayer component]',JSON.stringify(result));return result;
}
module.exports={installBundledHQPlayer};
