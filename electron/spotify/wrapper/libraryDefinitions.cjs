'use strict';
const fs=require('node:fs'),path=require('node:path');
// Persisted queries always come from this client's private resources, never another Spotify version.
const files=['xpui-modules.js','xpui-routes-artist.js','xpui-routes-search.js'];
const wanted=new Set(['getAlbum','queryAlbumTracks','queryArtistOverview','queryArtistDiscographyAlbums','home','searchArtists','searchAlbums']);
const cache=new Map();
function readLibraryDefinitions(apps){
  const result={};
  for(const name of files){
    const file=path.join(apps,'xpui',name);let stat;try{stat=fs.statSync(file);}catch{continue;}
    let entry=cache.get(file);
    if(entry?.mtime!==stat.mtimeMs){
      const source=fs.readFileSync(file,'utf8'),definitions={};
      for(const m of source.matchAll(/new [\w$.]+\("([\w]+)","query","([a-f0-9]{64})",null\)/g))if(wanted.has(m[1]))definitions[m[1]]={name:m[1],operation:'query',sha256Hash:m[2],value:null};
      entry={mtime:stat.mtimeMs,definitions};cache.set(file,entry);
    }
    Object.assign(result,entry.definitions);
  }
  return result;
}
module.exports={readLibraryDefinitions};
