'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {createLibraryReader}=require('../../electron/spotify/wrapper/libraryReader.cjs');
const {createLibraryMutations}=require('../../electron/spotify/wrapper/libraryMutations.cjs');
const normalize=require('../../electron/spotify/wrapper/libraryNormalize.cjs');
const {extensionSource}=require('../../electron/spotify/wrapper/extensionSource.cjs');
// Current-client query envelopes and real extension dispatch with controlled Spotify I/O.
const id='0123456789012345678901',other='1123456789012345678901';
for(const kind of ['album','artist']){
 test(`${kind} online search preserves collection type, paging and client fields`,async()=>{
  const calls=[],read=createLibraryReader({Platform:{},GraphQL:{Definitions:{},Request:async(definition,variables)=>{
   calls.push({definition,variables});return {data:{searchV2:{[kind==='album'?'albumsV2':'artists']:{items:[{data:{uri:`spotify:${kind}:${id}`,name:'Online '+kind,profile:{name:'Online artist'},coverArt:{sources:[{url:'https://i.scdn.co/image/a'}]}}}],totalCount:3,pagingInfo:{nextOffset:2}}}}};
  }}},normalize);
  const operation=kind==='album'?'searchAlbums':'searchArtists',result=await read({operation,query:'outside saved library',limit:1,definitions:{[operation]:{name:operation}}});
  assert.equal(calls[0].definition.name,operation);assert.equal(calls[0].variables.searchTerm,'outside saved library');
  assert.equal(result.items[0].type,kind);assert.equal(result.items[0].id,id);assert.equal(result.consumed,2);assert.equal(result.next,true);
 });
 test(`${kind} add/remove write to Spotify, verify readback and skip redundant writes`,async()=>{
  let saved=false;const writes=[],api={contains:async uri=>{assert.equal(uri,`spotify:${kind}:${id}`);return [saved];},add:async args=>{writes.push(args);saved=true;},remove:async args=>{writes.push(args);saved=false;}};
  const write=createLibraryMutations({Platform:{LibraryAPI:api,UserAPI:{getUser:async()=>({username:'me'})}}},async()=>{});
  for(const subscribed of [true,true,false])assert.deepEqual(await write({collectionType:kind,id,subscribed}),{id,type:kind,subscribed,confirmed:true,accountId:'me'});
  assert.equal(writes.length,2);assert.deepEqual(writes[0],{uris:[`spotify:${kind}:${id}`]});assert.equal(saved,false);
 });
}
test('distinct simultaneous artist terms never share the wrong request',async()=>{
 const terms=[],read=createLibraryReader({Platform:{},GraphQL:{Definitions:{searchArtists:{}},Request:async(_d,v)=>{terms.push(v.searchTerm);return {data:{searchV2:{artists:{items:[],totalCount:0}}}};}}},normalize);
 await Promise.all(['first','second'].map(query=>read({operation:'searchArtists',query})));assert.deepEqual(terms,['first','second']);
});
test('an unconfirmed write can fail and a later request can recover; account changes never confirm old results',async()=>{
 let changed=false,saveWorks=false,saved=false;
 const api={contains:async()=>[saved],add:async()=>{saved=saveWorks;},remove:async()=>{saved=false;}};
 const write=createLibraryMutations({Platform:{LibraryAPI:api,UserAPI:{getUser:async()=>({username:changed?'other':'me'})}}},async()=>{});
 await assert.rejects(write({collectionType:'artist',id,subscribed:true}),/LIBRARY_WRITE_UNCONFIRMED/);
 saveWorks=true;assert.equal((await write({collectionType:'artist',id,subscribed:true})).confirmed,true);
 api.remove=async()=>{saved=false;changed=true;};
 await assert.rejects(write({collectionType:'artist',id,subscribed:false}),/LIBRARY_ACCOUNT_CHANGED/);
});
test('write 429 stops subsequent requests without trying another library mutation',async()=>{
 let calls=0;const write=createLibraryMutations({Platform:{LibraryAPI:{contains:async()=>{calls++;throw {status:429};},add:async()=>{}},UserAPI:{getUser:async()=>({username:'me'})}}},async()=>{});
 for(let i=0;i<2;i++)await assert.rejects(write({collectionType:'album',id,subscribed:true}),/LIBRARY_RATE_LIMITED/);
 assert.equal(calls,1);
});
test('a queued failed collection write releases the next write and never blocks metadata/handshake',async()=>{
 let socket,finish,readCount=0,saved=false;const replies=[];
 const context={performance,Date,Intl,setTimeout,clearTimeout,document:{createElement:()=>({style:{}}),body:{append(){}}},
  WebSocket:class{constructor(){socket=this;this.readyState=1;}send(value){replies.push(JSON.parse(value));}},
  Spicetify:{Player:{},Platform:{UserAPI:{getUser:async()=>({username:'me'})},LibraryAPI:{contains:async()=>[saved],add:()=>{if(++readCount===1)return new Promise((_,reject)=>{finish=()=>reject(Error('network failed'));});saved=true;},getContentsPrimaryFilterId:()=> 'artist',getContents:async()=>({items:[],totalLength:0})}}}};
 vm.runInNewContext(extensionSource('ws://test'),context);
 const request=(n,op,args={})=>socket.onmessage({data:JSON.stringify({id:n,op,args})});
 request(1,'setCollectionSubscription',{collectionType:'artist',id,subscribed:true});await new Promise(setImmediate);
 request(2,'setCollectionSubscription',{collectionType:'album',id:other,subscribed:true});request(3,'hello');request(4,'libraryRead',{operation:'artists'});await new Promise(setImmediate);
 assert.equal(replies.find(r=>r.id===3).value.version,'1.3.0');assert.equal(replies.find(r=>r.id===4).ok,true);assert.equal(replies.some(r=>r.id===2),false);
 finish();await new Promise(setImmediate);assert.equal(replies.find(r=>r.id===1).code,'LIBRARY_WRITE_FAILED');assert.equal(replies.find(r=>r.id===2).value.confirmed,true);
});
