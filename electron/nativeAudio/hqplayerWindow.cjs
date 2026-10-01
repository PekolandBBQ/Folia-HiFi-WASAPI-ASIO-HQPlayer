const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { audioError } = require('./errors.cjs');

// Desktop window visibility is a Windows host concern, independent of the Control API/DSP component.
// Enumerate hidden windows too: Process.MainWindowHandle becomes zero after SW_HIDE.
async function hqplayerWindow(visible, { exec = promisify(execFile) } = {}) {
    if (visible !== undefined && typeof visible !== 'boolean') throw audioError('INVALID_REQUEST');
    const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FoliaHQWindow {
 public delegate bool Callback(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$ids=@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | ForEach-Object {$_.Id});
$handles=New-Object 'System.Collections.Generic.List[IntPtr]';
[void][FoliaHQWindow]::EnumWindows({param($h,$l)
 $owner=0; [void][FoliaHQWindow]::GetWindowThreadProcessId($h,[ref]$owner);
 if($ids -contains $owner){$title=New-Object System.Text.StringBuilder 512; [void][FoliaHQWindow]::GetWindowText($h,$title,512); if($title.ToString() -match 'HQPlayer'){$handles.Add($h)}}; return $true
},[IntPtr]::Zero);
${visible === undefined ? '' : `foreach($h in $handles){[void][FoliaHQWindow]::ShowWindowAsync($h,${visible ? 9 : 0}); ${visible ? '[void][FoliaHQWindow]::SetForegroundWindow($h);' : ''}}; Start-Sleep -Milliseconds 100;`}
$shown=@($handles | Where-Object {[FoliaHQWindow]::IsWindowVisible($_) -and -not [FoliaHQWindow]::IsIconic($_)}).Count -gt 0;
ConvertTo-Json -Compress -InputObject @{running=($ids.Count -gt 0);visible=$shown;controllable=($handles.Count -gt 0)}`;
    try {
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
        return JSON.parse(stdout.trim());
    } catch (error) { throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', `Cannot control HQPlayer window: ${error.message}`); }
}
module.exports = { hqplayerWindow };
