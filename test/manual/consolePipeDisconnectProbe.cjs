const { app } = require('electron');
const { installConsolePipeGuard } = require('../../electron/debug/consolePipeGuard.cjs');
const fs = require('node:fs');

// Reproduce the screenshot's exact Electron console sink, without opening a DAC or UI window.
installConsolePipeGuard();
app.whenReady().then(() => {
    process.stdout.write('ready');
    // Electron's GUI executable does not promise a readable console stdin on Windows.
    setTimeout(() => {
        for (let index = 0; index < 20; index++) console.info('[PlaybackPreparation]', { index });
        setTimeout(() => { fs.writeFileSync(process.argv[2], 'work-completed'); app.exit(0); }, 100);
    }, 1000);
});
