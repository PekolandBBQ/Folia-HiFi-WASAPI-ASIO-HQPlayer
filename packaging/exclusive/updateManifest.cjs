'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
// Publish byte-identical packages on hosts with a 100 MB attachment limit.
async function prepareUpdateArtifacts(output,release,partSize=90*1024*1024){
 const manifest={schema:1,tag:release.forkTag,build:release.build,
  installer:`${release.productName}-${release.version}-win-x64-Setup.exe`,
  portable:`${release.productName}-${release.version}-win-x64.zip`,parts:{}};
 for(const kind of ['installer','portable']){
  const file=await fs.open(path.join(output,manifest[kind]),'r');const pieces=[];
  try{let index=0,offset=0;const buffer=Buffer.alloc(partSize);for(;;){const {bytesRead}=await file.read(buffer,0,partSize,offset);if(!bytesRead)break;offset+=bytesRead;
   const name=manifest[kind]+'.'+String(++index).padStart(3,'0');await fs.writeFile(path.join(output,name),buffer.subarray(0,bytesRead));pieces.push({name,size:bytesRead});
  }}finally{await file.close();}
  if(!pieces.length)throw Error(`Empty update package: ${kind}`);manifest.parts[kind]=pieces;
 }
 await fs.writeFile(path.join(output,'folia-hifi-update.json'),JSON.stringify(manifest,null,2)+'\n');
 return manifest;
}
module.exports={prepareUpdateArtifacts};
