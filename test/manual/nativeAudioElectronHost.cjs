const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerNativeAudio } = require('../../electron/nativeAudio/service.cjs');

// test/manual/nativeAudioElectronHost.cjs — isolated hidden window; production preload and audio service.
const root = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(root, 'test-results/native-audio-electron-profile'), { recursive: true });
app.setPath('userData', path.join(root, 'test-results/native-audio-electron-profile'));
let window;
ipcMain.handle('automix-models-present', () => ({ beatThis: false, htdemucs: false }));
ipcMain.handle('set-app-locale', () => {});
registerNativeAudio({ app: { isPackaged: false, getAppPath: () => root,
    getPath: name => app.getPath(name), on: app.on.bind(app) }, ipcMain,
isTrustedSender: sender => sender === window?.webContents });
app.whenReady().then(() => {
    window = new BrowserWindow({ show: false, width: 1100, height: 800,
        webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, sandbox: true } });
    void window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
