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
}
'@
$ids=@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | ForEach-Object {$_.Id});
$rows=New-Object 'System.Collections.Generic.List[object]';
[void][FoliaWindowProbe]::EnumWindows({param($h,$l) $owner=0; [void][FoliaWindowProbe]::GetWindowThreadProcessId($h,[ref]$owner); if($ids -contains $owner){$rows.Add(@{pid=$owner;handle=$h.ToInt64();visible=[FoliaWindowProbe]::IsWindowVisible($h);minimized=[FoliaWindowProbe]::IsIconic($h)})}; return $true},[IntPtr]::Zero);
ConvertTo-Json -Depth 5 -Compress -InputObject @{pids=$ids;windows=@($rows.ToArray())}`;
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
}
module.exports = { hqplayerWindowState };
