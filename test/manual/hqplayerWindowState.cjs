const { execFileSync } = require('node:child_process');

// Read top-level windows for HQPlayer only; no focus or visibility changes are made by this probe.
function hqplayerWindowState() {
    const script = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FoliaWindowProbe {
 public delegate bool Callback(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
}
'@
$ids=@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | ForEach-Object {$_.Id});
$rows=New-Object 'System.Collections.Generic.List[object]';
[void][FoliaWindowProbe]::EnumWindows({param($h,$l) $owner=0; [void][FoliaWindowProbe]::GetWindowThreadProcessId($h,[ref]$owner); if($ids -contains $owner){$cloak=0;$hr=[FoliaWindowProbe]::DwmGetWindowAttribute($h,14,[ref]$cloak,4);$rows.Add(@{pid=$owner;handle=$h.ToInt64();visible=[FoliaWindowProbe]::IsWindowVisible($h);minimized=[FoliaWindowProbe]::IsIconic($h);cloaked=$(if($hr -eq 0){$cloak}else{$null});dwmResult=$hr})}; return $true},[IntPtr]::Zero);
ConvertTo-Json -Depth 5 -Compress -InputObject @{pids=$ids;windows=@($rows.ToArray())}`;
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
}
function assertHQPlayerWindowVisibility(state, silent) {
    if (!Array.isArray(state?.pids) || state.pids.length !== 1 || !Array.isArray(state.windows) || !state.windows.length)
        throw new Error('HQPlayer window evidence or single instance is unavailable');
    const eligible = state.windows.filter(window => window.visible && !window.minimized);
    if (eligible.some(window => !Number.isInteger(window.cloaked) || window.cloaked < 0 || window.dwmResult !== 0))
        throw new Error('HQPlayer screen visibility could not be verified: DWM observation failed');
    const visible = eligible.some(window => window.cloaked === 0);
    if (visible === silent) throw new Error('HQPlayer requested screen visibility mismatch');
    return visible;
}
module.exports = { hqplayerWindowState, assertHQPlayerWindowVisibility };
