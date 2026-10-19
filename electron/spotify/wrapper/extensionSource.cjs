'use strict';
const fs=require('node:fs'),path=require('node:path');
// Compose one installed extension so configuration and upgrade cannot omit its library modules.
function extensionSource(url){
  return ['libraryNormalize.cjs','libraryReader.cjs','libraryMutations.cjs','extension.js'].map(name=>fs.readFileSync(path.join(__dirname,name),'utf8')).join('\n').replace('__FOLIA_LIVE_URL__',JSON.stringify(url));
}
module.exports={extensionSource};
