'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createSpotifyCatalog } = require('../../electron/spotify/catalog.cjs');
const { observeSpotifyOperation } = require('../../electron/spotify/privatePreviewObserver.cjs');
const { installPreviewDiagnosticSink } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
const { previewPlaylistRef } = require('../../electron/spotify/playlistDiagnostics.cjs');
const { projectEvent } = require('../../electron/debug/privatePreviewDiagnosticSchema.cjs');
const { projectRendererLibrary, createPlaylistCatalogDiagnostics } = require('../../electron/spotify/playlistCatalogDiagnostics.cjs');

// test/node/spotifyPlaylistProvenanceDiagnostics.test.cjs — no live account, device, credentials, or network.
const id = index => String(index).padStart(22, '0');
const row = (index, extra = {}) => ({ id: id(index), name: 'PRIVATE_TITLE_SENTINEL', type: 'playlist', public: true, collaborative: false,
  owner: { id: 'PRIVATE_OTHER_ACCOUNT', display_name: 'PRIVATE_USERNAME' }, ...extra });
const capture = () => { const events = []; const detach = installPreviewDiagnosticSink({ enabled: () => true,
  record(type, fields) { events.push({ type, fields }); return true; } }); return { events, detach }; };
function fixture() {
  const calls = [], reads = [], publicReads = [], artworkReads = [];
  const pages = [[row(1, { owner: { id: 'PRIVATE_SELF_ACCOUNT' } }), row(2), row(3, { collaborative: true })],
    [row(4, { public: undefined, collaborative: undefined, owner: null }), row(2), null]];
  const snapshot = { id: id(2), name: 'PRIVATE_EMBED_TITLE', tracks: [{ id: id(99), title: 'PRIVATE_TRACK_TITLE', sourceUrl: 'https://PRIVATE_URL' },
    { id: id(99), title: 'PRIVATE_DUPLICATE_TITLE', sourceUrl: 'https://PRIVATE_URL' }], partial: true, complete: false, total: null, fetchedAt: 0 };
  let failPublic = false;
  const api = createSpotifyCatalog({ now: () => 1, cooldown: { load: async () => 0 },
    vault: { token: async () => { reads.push('token'); return 'PRIVATE_TOKEN_SENTINEL'; } },
    publicMetadata: { clear() {}, async get(value) { publicReads.push(value); if (failPublic) throw Object.assign(new Error('PRIVATE_URL'), { code: 'network' }); return snapshot; } },
    publicArtwork: { clear() {}, async enrich(rows) { artworkReads.push(rows.length); return rows; } },
    fetcher: async (url, options) => {
      calls.push(url); assert.equal(options.headers.Authorization, 'Bearer PRIVATE_TOKEN_SENTINEL');
      const route = new URL(url);
      if (route.pathname === '/v1/me') return Response.json({ id: 'PRIVATE_SELF_ACCOUNT', display_name: 'PRIVATE_USERNAME' });
      if (route.pathname === '/v1/me/playlists') {
        const offset = Number(route.searchParams.get('offset'));
        return Response.json({ items: pages[offset === 0 ? 0 : 1], offset, limit: 50, total: 6, next: offset === 0 ? 'https://PRIVATE_NEXT_URL' : null });
      }
      return new Response('PRIVATE_RESPONSE_BODY', { status: 403 });
    } });
  const request = input => observeSpotifyOperation('service', input, context => api.request(input.action, input, context));
  return { api, request, calls, reads, publicReads, artworkReads, pages, failPublic: () => { failPublic = true; } };
}
async function scenario() {
  const f = fixture();
  await f.request({ action: 'status' });
  const pages = [await f.request({ action: 'playlists', offset: 0, limit: 50 }), await f.request({ action: 'playlists', offset: 50, limit: 50 })];
  const detail = await f.request({ action: 'playlist', id: id(2) });
  const first = await f.request({ action: 'playlistTracks', id: id(2), offset: 0, limit: 1 });
  const second = await f.request({ action: 'playlistTracks', id: id(2), offset: 1, limit: 1 });
  for (const value of [1, 3, 4, 8]) await assert.rejects(f.request({ action: 'playlistTracks', id: id(value), offset: 0 }), { httpStatus: 403 });
  return { calls: f.calls, reads: f.reads, publicReads: f.publicReads, artworkReads: f.artworkReads, pages, detail, first, second };
}
test('passive diagnostics preserve all catalog results and exactly the existing requests, token reads, public reads and artwork work', async () => {
  const baseline = await scenario(), c = capture();
  try {
    const observed = await scenario(); assert.deepEqual(observed, baseline);
    assert.equal(observed.calls.length, 9); assert.equal(observed.publicReads.length, 2);
    assert.equal(observed.pages[1].items.at(-1), null); assert.equal(observed.pages[1].items[1].id, id(2));
    const pages = c.events.filter(e => e.type === 'spotify.playlist' && e.fields.phase === 'directory-page');
    assert.deepEqual(pages.map(e => [e.fields.pageOffset, e.fields.rawCount, e.fields.totalCount, e.fields.hasContinuation]), [[0, 3, 6, true], [50, 3, 6, false]]);
    assert.ok(pages.every(e => Number.isInteger(e.fields.operationRef)));
    assert.notEqual(pages[0].fields.operationRef, pages[1].fields.operationRef);
    const rows = c.events.filter(e => e.type === 'spotify.playlist' && e.fields.phase === 'directory-item');
    assert.deepEqual(rows.slice(0, 4).map(e => [e.fields.ownerSelf, e.fields.publicState, e.fields.collaborativeState]),
      [['yes','yes','no'], ['no','yes','no'], ['no','yes','yes'], ['unknown','unknown','unknown']]);
    const ref = rows[1].fields.playlistRef;
    assert.equal(ref, rows[4].fields.playlistRef);
    const fallbacks = c.events.filter(e => e.type === 'spotify.playlist' && e.fields.phase === 'fallback-result');
    assert.deepEqual(fallbacks.map(e => [e.fields.playlistRef, e.fields.source, e.fields.partial]), [[ref,'public',true], [ref,'public',true], [ref,'cache',true]]);
    const reasons = c.events.filter(e => e.type === 'spotify.playlist' && e.fields.phase === 'fallback-check' && !e.fields.eligible).map(e => e.fields.reason);
    assert.deepEqual(reasons, ['owned','collaborative-playlist','unknown','not-listed']);
    assert.doesNotMatch(JSON.stringify(c.events), /PRIVATE_|https?:|000000000000|ownerId|accountId|Authorization|Bearer/);
    assert.ok(c.events.every(e => Buffer.byteLength(JSON.stringify(e)) < 1200));
  } finally { c.detach(); }
});
test('public metadata failure stays an error and is correlated without recording its message', async () => {
  const c = capture(); try {
    const f = fixture(); await f.request({ action:'status' }); await f.request({ action:'playlists' }); f.failPublic();
    await assert.rejects(f.request({ action:'playlist', id:id(2) }), { code:'network' });
    const e = c.events.find(e => e.type === 'spotify.playlist' && e.fields.phase === 'fallback-result');
    assert.deepEqual([e.fields.source, e.fields.reason, e.fields.errorCode, e.fields.ok], ['public','failed','network',false]);
    assert.equal(e.fields.playlistRef, previewPlaylistRef(id(2))); assert.equal(f.calls.length,3); assert.equal(f.publicReads.length,1);
    assert.doesNotMatch(JSON.stringify(c.events), /PRIVATE_|https?:/);
  } finally { c.detach(); }
});
test('renderer IPC projection shares main refs, resets each run, omits invalid IDs and rejects arbitrary fields/getters', () => {
  for (let run=0; run<2; run++) { const c=capture(); try {
    const ref=previewPlaylistRef(id(2)); assert.equal(ref,1);
    const fields=projectRendererLibrary({phase:'cache-before',playlistId:id(2),playlistRef:999,refreshRef:7,source:'public',name:'PRIVATE_TITLE',ownerId:'PRIVATE_OWNER',url:'https://PRIVATE_URL'});
    assert.deepEqual(fields,{phase:'cache-before',refreshRef:7,source:'public',playlistRef:ref});
    assert.equal(projectEvent('spotify.library',{phase:'hydrate',playlistId:id(2)}).fields.playlistId,undefined);
    assert.equal(projectRendererLibrary({phase:'hydrate',playlistId:'PRIVATE_INVALID'}).playlistRef,undefined);
    let touched=0; const hostile={phase:'hydrate'}; Object.defineProperty(hostile,'playlistId',{get(){touched++;throw Error();}});
    Object.defineProperty(hostile,'rawCount',{get(){touched++;throw Error();}});
    assert.deepEqual(projectRendererLibrary(hostile),{phase:'hydrate'}); assert.equal(touched,0);
    assert.deepEqual(projectEvent('spotify.library',{phase:'cache-replace',rawCount:100001,source:'PRIVATE',beforeCount:NaN,ok:'PRIVATE',extra:{title:'PRIVATE'}}).fields,{phase:'cache-replace'});
  } finally {c.detach();} }
  assert.equal(projectRendererLibrary({phase:'hydrate',playlistId:id(2)}),null);
});
test('directory sample and page budgets cap logs without limiting actual playlist arrays or performing I/O', () => {
  const c=capture(); try {
    const observer=createPlaylistCatalogDiagnostics();
    for(let page=0;page<1000;page++) {
      const raw={items:Array.from({length:50},(_,i)=>row(page*50+i)),total:50000,limit:50,next:'PRIVATE_NEXT'};
      observer.directory(raw,page*50,'PRIVATE_SELF',observer.context(page*50,{operationRef:page+1})); assert.equal(raw.items.length,50);
    }
    assert.equal(c.events.filter(e=>e.fields.phase==='directory-item').length,100);
    assert.equal(c.events.filter(e=>e.fields.phase==='directory-page').length,100);
    assert.equal(c.events.at(-1).fields.capped,true);
    assert.ok(Buffer.byteLength(JSON.stringify(c.events))<70000);
  } finally {c.detach();}
});
function loadTs(relative, exports, bindings) {
  const filename=path.resolve(__dirname,'../..',relative);
  let code=stripTypeScriptTypes(fs.readFileSync(filename,'utf8'),{mode:'strip'});
  code=code.replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm,'').replace(/^export /gm,'');
  return vm.runInNewContext(`(function(){${code};return {${exports.join(',')}}})()`,bindings,{filename});
}
function rendererFixture(events) {
  let reference=0;
  const diagnostics=loadTs('src/services/onlineMusic/spotifyLibraryDiagnostics.ts', ['observeSpotifyLibraryPage','createSpotifyLibraryObservation','observeSpotifyLibraryHydration'],{
    getPrivateDiagnosticsApi:()=>({}),nextPrivateDiagnosticRef:()=>++reference,
    recordPrivateDiagnostic:record=>events.push({type:record.event,fields:projectRendererLibrary(record.fields)}) });
  class OnlineProviderError extends Error { constructor(code,message){super(message);this.code=code;} }
  const normalize=loadTs('src/services/onlineMusic/spotifyNormalize.ts',['normalizeSpotifyCollection','normalizeSpotifyPage'],{OnlineProviderError,i18n:{t:key=>key}});
  const pagination=loadTs('src/services/onlineMusic/providerPagination.ts',['collectProviderPages'],{OnlineProviderError});
  return {...diagnostics,...normalize,...pagination};
}
test('real normalization and pagination observe duplicates and preserve null-page failure; cache replacement shows removed public provenance',async()=>{
  const c=capture();try{
    const r=rendererFixture(c.events),raw={items:[row(1),row(2)],metadataSource:'spotify-api',next:'PRIVATE_NEXT',total:3};
    const raw2={items:[row(2)],metadataSource:'spotify-api',next:null,total:3};
    const before=[{id:id(9),name:'PRIVATE_CACHE_TITLE',providerId:'spotify',type:'playlist',metadataSource:'spotify-public-embed'}];
    const o=r.createSpotifyLibraryObservation('spotify',before);let calls=0;
    const result=await r.collectProviderPages({providerId:'spotify',getKey:item=>item.id,onPage:o.page,fetchPage:async offset=>{
      calls++;const page=offset===0?raw:raw2;return r.observeSpotifyLibraryPage(page,offset,()=>r.normalizeSpotifyPage(page,offset,r.normalizeSpotifyCollection));
    }});
    assert.equal(calls,2);assert.equal(result.length,2);o.replace(before,result);o.result(true);
    assert.ok(c.events.some(e=>e.fields.phase==='dedup-page'&&e.fields.duplicateCount===1));
    const replace=c.events.find(e=>e.fields.phase==='cache-replace').fields;
    assert.deepEqual([replace.beforeCount,replace.afterCount,replace.publicBeforeCount,replace.publicAfterCount,replace.removedCount],[1,2,1,0,1]);
    const removed=c.events.find(e=>e.fields.reason==='removed');assert.equal(removed.fields.playlistRef,previewPlaylistRef(id(9)));assert.equal(removed.fields.source,'public');
    const failure={items:[null,row(3)]};let original;
    try{r.normalizeSpotifyPage(failure,0,r.normalizeSpotifyCollection);}catch(error){original=error;}
    assert.throws(()=>r.observeSpotifyLibraryPage(failure,0,()=>{throw original;}),error=>error===original);
    const failed=c.events.filter(e=>e.fields.phase==='normalized-page'&&e.fields.ok===false).at(-1);
    assert.equal(failed.fields.nullCount,1);assert.equal(failed.fields.reason,'invalid-row');
    assert.doesNotMatch(JSON.stringify(c.events),/PRIVATE_|https?:|000000000000|playlistId/);
  }finally{c.detach();}
});
test('renderer observation logs have count caps and observer callback failures never change page results',async()=>{
  const c=capture();try{
    const r=rendererFixture(c.events);const rows=Array.from({length:1000},(_,i)=>({id:id(i),name:'PRIVATE',type:'playlist',providerId:'spotify'}));
    const o=r.createSpotifyLibraryObservation('spotify',rows);o.replace(rows,rows);o.result(true);
    assert.ok(c.events.length<=256);assert.ok(c.events.some(e=>e.fields.capped));
    const result=await r.collectProviderPages({getKey:item=>item.id,onPage(){throw new Error('PRIVATE');},fetchPage:async()=>({items:rows,nextOffset:1000,hasMore:false})});
    assert.equal(result.length,1000);assert.ok(Buffer.byteLength(JSON.stringify(c.events))<70000);
  }finally{c.detach();}
});

test('playlist references remain stable after unrelated session churn; capacity omits new IDs and resets with a run', () => {
  const { previewSessionRef } = require('../../electron/debug/privatePreviewDiagnosticBus.cjs');
  const c=capture(); try {
    const first=previewPlaylistRef(id(0));
    for(let i=0;i<2000;i++) previewSessionRef('unrelated-session-'+i);
    assert.equal(previewPlaylistRef(id(0)),first);
    for(let i=1;i<256;i++) assert.ok(previewPlaylistRef(id(i)));
    assert.equal(previewPlaylistRef(id(256)),undefined);
    assert.deepEqual(projectRendererLibrary({phase:'cache-after',playlistId:id(256)}),{phase:'cache-after',capped:true});
    assert.equal(previewPlaylistRef(id(0)),first);
  } finally { c.detach(); }
  const next=capture(); try { assert.equal(previewPlaylistRef(id(256)),1); } finally { next.detach(); }
});
