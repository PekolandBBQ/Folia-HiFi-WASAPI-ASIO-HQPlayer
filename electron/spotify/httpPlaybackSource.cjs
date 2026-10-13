'use strict';
const { createDesktopPlaybackApi } = require('./desktopPlaybackApi.cjs');
const { playbackFacts } = require('./desktopPlaybackFacts.cjs');

// electron/spotify/httpPlaybackSource.cjs: unchanged official HTTP API and GET-body projection behind the shared source seam.
function createHttpPlaybackSource(dependencies) {
  return { ...createDesktopPlaybackApi(dependencies), playbackFacts,
    describeState(body) { return { deviceId: body?.device?.id,
      trackId: /^spotify:track:([A-Za-z0-9]{22})$/.exec(body?.item?.uri)?.[1], durationMs: body?.item?.duration_ms }; },
  };
}
module.exports = { createHttpPlaybackSource };
