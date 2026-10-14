'use strict';
const { execFile } = require('node:child_process');
const { fail } = require('./componentPackage.cjs');

// electron/spotify/driverVersion.cjs — check installed VB-CABLE version once per explicit preparation action.
function cableDriverVersion() {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -eq 'VB-Audio Virtual Cable' } | Select-Object -ExpandProperty DriverVersion) | ConvertTo-Json -Compress"],
    { windowsHide: true, timeout: 20000 }, (error, output) => {
      if (error) return reject(fail('SPOTIFY_DRIVER_VERSION_CHECK_FAILED'));
      try { const value = output.trim() ? JSON.parse(output) : []; resolve(Array.isArray(value) ? value : [value]); }
      catch { reject(fail('SPOTIFY_DRIVER_VERSION_CHECK_FAILED')); }
    }));
}
module.exports = { cableDriverVersion };
