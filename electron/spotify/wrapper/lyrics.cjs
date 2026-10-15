'use strict';
// Only cache positive lyrics in the extension; classify uncertain empties without blocking audio.
const reasons = {
  received:'已收到歌词', 'http-not-found':'Spotify 歌词接口返回 404，本次未找到歌词',
  'missing-lyrics':'响应缺少歌词对象，不能判定歌曲无歌词', 'invalid-lines':'歌词行字段格式异常',
  'blank-lines':'响应中的歌词行没有可显示文本', 'empty-lines':'本次响应的歌词行数组为空',
  'unclassified-empty':'旧桥接返回空歌词，未提供具体原因',
  LYRICS_RATE_LIMITED:'Spotify 歌词请求已限流，本会话不再重试',
  LYRICS_AUTH_REQUIRED:'Spotify 歌词请求未获授权', LYRICS_ACCESS_DENIED:'Spotify 拒绝访问此歌词',
  CONTROL_TIMEOUT:'等待 Spotify 歌词响应超时', SPOTIFY_INSTANCE_CHANGED:'Spotify 桥接连接已变化',
  LYRICS_UNAVAILABLE:'Spotify 歌词请求临时失败',
};
async function requestNativeLyrics(bridge, args, log, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const started = Date.now();
  const report = (event, detail) => { log(event, detail); console.info('[SpotifyLyrics]', JSON.stringify({event,...detail})); };
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const result = await bridge.request('lyrics', args);
      const reason = result.reason || (result?.lines?.length ? 'received' : 'unclassified-empty');
      const retry = attempt < 3 && ['missing-lyrics','invalid-lines','blank-lines','empty-lines'].includes(reason);
      report('native-lyrics-result', {trackId:args.trackId,attempt:attempt+1,elapsedMs:Date.now()-started,
        lineCount:result?.lines?.length||0,syncType:result?.syncType,outcome:result?.lines?.length?'received':'empty-response',
        reason,reasonText:reasons[reason],httpStatus:result.httpStatus,cacheHit:result.cacheHit,responseShape:result.responseShape,retry});
      if (!retry) return result;
    } catch (error) {
      const code = error?.code || error?.message;
      const retry = attempt < 3 && ['CONTROL_TIMEOUT','SPOTIFY_INSTANCE_CHANGED','LYRICS_UNAVAILABLE'].includes(code);
      report('native-lyrics-failure', {trackId:args.trackId,attempt:attempt+1,elapsedMs:Date.now()-started,code,reasonText:reasons[code],retry});
      if (!retry) throw error;
    }
    await wait([250,500,1000][attempt]);
  }
}
module.exports = {requestNativeLyrics};
