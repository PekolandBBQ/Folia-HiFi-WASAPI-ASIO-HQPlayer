const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// test/manual/nativeAudioReviewHost.cjs — isolated accounts for manual provider validation.
const profile = path.join(process.env.LOCALAPPDATA, 'FoliaNativeReview', 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
// Loopback-only debugging is opt-in for the isolated review harness, never the shipped app.
if (process.env.FOLIA_REVIEW_DEBUG === '1') {
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
    app.commandLine.appendSwitch('remote-debugging-port', '19333');
}
process.env.ELECTRON_DEV = 'true';
process.env.NODE_ENV = 'development';
process.env.FOLIA_TRANSCODE_FFMPEG_PATH ||= path.resolve(__dirname, '../../ffmpeg-audio/ffmpeg.exe');
process.env.FOLIA_NATIVE_FFMPEG_PATH ||= path.resolve(__dirname, '../../build/ffmpeg/win-x64/ffmpeg.exe');
require('../../electron/main.cjs');
