'use strict';
const { own, sourceErrorCode } = require('../debug/privatePreviewDiagnosticSchema.cjs');
const { isPreviewDiagnosticsEnabled, publishPreviewDiagnostic, previewSessionRef } = require('../debug/privatePreviewDiagnosticBus.cjs');
const { playlistResponseFields } = require('./playlistDiagnostics.cjs');

// Main-only value projections. Observing an existing result never performs extra account or runtime I/O.
function pauseResponseFields(response) {
  // Header values never leave this projection; unexpected accessors cannot change a request result.
  const category = (name, classify) => {
    try {
      const value = response.headers.get(name);
      if (value == null) return 'missing';
      if (typeof value !== 'string' || value.length > 256) return 'other';
      return classify(value.toLowerCase().trim());
    } catch { return 'other'; }
  };
  return {
    contentType: category('content-type', value => {
      const type = value.split(';', 1)[0].trim();
      if (type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) return 'json';
      if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
      return type.startsWith('text/') ? 'text' : 'other';
    }),
    contentEncoding: category('content-encoding', value => ['identity', 'gzip', 'br', 'deflate'].includes(value) ? value : 'other'),
  };
}

function reportSpotifyHttp(endpoint, method, httpStatus, paging, body, context) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const page = endpoint === 'catalog-search' ? own(body, 'tracks') : body;
    const items = own(page, 'items'), next = own(page, 'next');
    publishPreviewDiagnostic('spotify.http', { endpoint, method, httpStatus,
      operationRef: own(context, 'operationRef'), playlistRef: own(context, 'playlistRef'),
      pageOffset: own(paging, 'offset'), pageLimit: own(paging, 'limit'),
      ...(Array.isArray(items) ? { rawCount: items.length, totalCount: own(page, 'total'),
        hasContinuation: next === null ? false : typeof next === 'string' ? next.length > 0 : undefined } : {}),
      ...playlistResponseFields(endpoint, body) });
  } catch { /* Diagnostics cannot change the request result. */ }
}
function reportSpotifyScopes(scope) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const scopesKnown = typeof scope === 'string' && scope.length <= 4096;
    const scopes = scopesKnown ? new Set(scope.split(/\s+/)) : null;
    publishPreviewDiagnostic('spotify.scopes', { scopesKnown,
      ...(scopes ? { playlistReadPrivate: scopes.has('playlist-read-private'),
        playlistReadCollaborative: scopes.has('playlist-read-collaborative'), userLibraryRead: scopes.has('user-library-read'),
        playbackRead: scopes.has('user-read-playback-state'), playbackModify: scopes.has('user-modify-playback-state') } : {}) });
  } catch { /* Diagnostics cannot change a vault read. */ }
}
function reportSpotifyPlaybackControl(endpoint, method, httpStatus, observation) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    publishPreviewDiagnostic('spotify.playback-control', { endpoint, method, httpStatus,
      phase: own(observation, 'phase'), bodyShape: own(observation, 'bodyShape'), bodyBytes: own(observation, 'bodyBytes'),
      contentType: own(observation, 'contentType'), contentEncoding: own(observation, 'contentEncoding'),
      observationCount: own(observation, 'observationCount'), deviceMatched: own(observation, 'deviceMatched'),
      trackMatched: own(observation, 'trackMatched'), paused: own(observation, 'paused'),
      playing: own(observation, 'playing'), progressPlausible: own(observation, 'progressPlausible'), emptyState: own(observation, 'emptyState'),
      stablePosition: own(observation, 'stablePosition'), positionWithinTolerance: own(observation, 'positionWithinTolerance'),
      errorCode: own(observation, 'errorCode') });
  } catch { /* Only allowlisted response facts; never a body, token, URL, or exception message. */ }
}
function reportSpotifyPreparationFailure(requestId, stage, cause, failure) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    publishPreviewDiagnostic('spotify.preparation', { sessionRef: previewSessionRef(requestId), stage,
      errorCode: sourceErrorCode(failure), causeCode: sourceErrorCode(cause) });
  } catch { /* Never include an exception message or arbitrary cause. */ }
}
// errorCode/causeCode accept Error-like objects with an own .code, never message text.
function reportSpotifyColdBootstrap(sessionId, stage, phase, facts) {
  if (!isPreviewDiagnosticsEnabled()) return;
  try {
    const error = own(facts, 'errorCode'), cause = own(facts, 'causeCode');
    publishPreviewDiagnostic('spotify.cold-bootstrap', { sessionRef: previewSessionRef(sessionId), stage, phase,
      ...(error !== undefined ? { errorCode: sourceErrorCode(error) } : {}),
      ...(cause !== undefined ? { causeCode: sourceErrorCode(cause) } : {}),
      observationCount: own(facts, 'observationCount'),
      baselineEmpty: own(facts, 'baselineEmpty'), observedEmpty: own(facts, 'observedEmpty'),
      deviceMatched: own(facts, 'deviceMatched'), paused: own(facts, 'paused'), volumeMatched: own(facts, 'volumeMatched'),
      selectInvoked: own(facts, 'selectInvoked'), selectConfirmed: own(facts, 'selectConfirmed'),
      activationConfirmed: own(facts, 'activationConfirmed'), receiptRetained: own(facts, 'receiptRetained') });
  } catch { /* Fixed observed facts only; diagnostics never change control or recovery. */ }
}
module.exports = { reportSpotifyHttp, reportSpotifyScopes, reportSpotifyPreparationFailure, reportSpotifyPlaybackControl,
  reportSpotifyColdBootstrap, pauseResponseFields };
