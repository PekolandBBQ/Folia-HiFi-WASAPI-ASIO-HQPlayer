const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { audioError } = require('./errors.cjs');

// Window intent belongs to the current Desktop process, independently of its startup preference.
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
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint RegisterWindowMessage(string n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, IntPtr l, uint f, uint t, out UIntPtr r);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenEvent(uint a, bool i, string n);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetEvent(IntPtr h);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ResetEvent(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$ErrorActionPreference='Stop';
$ids=@(Get-Process | Where-Object {$_.ProcessName -match '^HQPlayer[0-9]*Desktop$'} | ForEach-Object {$_.Id});
$guarded=New-Object 'System.Collections.Generic.List[int]';
${visible === undefined ? '' : `foreach($processId in $ids){
 $gate=[FoliaHQWindow]::OpenEvent(0x100002,$false,('Local\\Folia-HQPlayer-Visibility-'+$processId));
 if($gate -eq [IntPtr]::Zero){
  $gateError=[Runtime.InteropServices.Marshal]::GetLastWin32Error();
  if($gateError -ne 2){throw 'HQPlayer visibility gate unavailable'}
 }else{try{
  if(-not [FoliaHQWindow]::${visible ? 'SetEvent' : 'ResetEvent'}($gate)){throw 'HQPlayer visibility gate update failed'};
  $guarded.Add($processId)
 }finally{[void][FoliaHQWindow]::CloseHandle($gate)}}
};`}
$handles=New-Object 'System.Collections.Generic.List[IntPtr]';
$panels=New-Object 'System.Collections.Generic.List[IntPtr]';
[void][FoliaHQWindow]::EnumWindows({param($h,$l)
 $owner=0; [void][FoliaHQWindow]::GetWindowThreadProcessId($h,[ref]$owner);
 if($ids -contains $owner){
  $title=New-Object System.Text.StringBuilder 512;
  [void][FoliaHQWindow]::GetWindowText($h,$title,512);
  $mainPanel=$title.ToString() -match 'HQPlayer';
  $cloakStatus=0; $cloakQuery=[FoliaHQWindow]::DwmGetWindowAttribute($h,14,[ref]$cloakStatus,4);
  if($mainPanel){$panels.Add($h)};
  if($mainPanel -or ($cloakQuery -eq 0 -and ([FoliaHQWindow]::IsWindowVisible($h) -or ($cloakStatus -band 1) -ne 0))){$handles.Add($h)}
 }; return $true
},[IntPtr]::Zero);
${visible === undefined ? '' : `${visible ? `$ordered=New-Object 'System.Collections.Generic.List[IntPtr]';
$visited=New-Object 'System.Collections.Generic.HashSet[IntPtr]';
$visiting=New-Object 'System.Collections.Generic.HashSet[IntPtr]';
# Release an owner's cloak before its dialogs, including dialogs whose title also contains HQPlayer.
function Add-FoliaHQWindow {param([IntPtr]$windowHandle)
 if($visited.Contains($windowHandle)){return};
 if(-not $visiting.Add($windowHandle)){throw 'Invalid HQPlayer window ownership'};
 $ownerWindow=[FoliaHQWindow]::GetWindow($windowHandle,4);
 if($ownerWindow -ne [IntPtr]::Zero -and $handles.Contains($ownerWindow)){Add-FoliaHQWindow $ownerWindow};
 [void]$visiting.Remove($windowHandle); [void]$visited.Add($windowHandle); $ordered.Add($windowHandle)
};
foreach($h in @($panels)+@($handles | Where-Object {-not $panels.Contains($_)})){Add-FoliaHQWindow $h};` : '$ordered=$handles;'}
$apply=[FoliaHQWindow]::RegisterWindowMessage('Folia.HQPlayer.Visibility.Apply.v1');
if($apply -eq 0){throw 'HQPlayer visibility message unavailable'};
foreach($h in $ordered){
 $owner=0; [void][FoliaHQWindow]::GetWindowThreadProcessId($h,[ref]$owner);
 if($guarded -contains $owner -and [FoliaHQWindow]::IsWindow($h)){
  $reply=[UIntPtr]::Zero;
  if([FoliaHQWindow]::SendMessageTimeout($h,$apply,[UIntPtr]::Zero,[IntPtr]::Zero,2,1000,[ref]$reply) -eq [IntPtr]::Zero){throw 'HQPlayer visibility apply timed out'};
  $cloakStatus=0;
  if([FoliaHQWindow]::DwmGetWindowAttribute($h,14,[ref]$cloakStatus,4) -ne 0 -or (($cloakStatus -band 1) -ne 0) -ne ${visible ? '$false' : '$true'}){throw 'HQPlayer window visibility update unconfirmed'}
 }${visible ? '' : `elseif($ids -contains $owner){[void][FoliaHQWindow]::ShowWindowAsync($h,0)}`}
};
foreach($h in $panels){[void][FoliaHQWindow]::ShowWindowAsync($h,${visible ? 9 : 0}); ${visible ? '[void][FoliaHQWindow]::SetForegroundWindow($h);' : ''}};
Start-Sleep -Milliseconds 100;`}
$shown=@($panels | Where-Object {
 $cloakStatus=0;
 if([FoliaHQWindow]::DwmGetWindowAttribute($_,14,[ref]$cloakStatus,4) -ne 0){throw 'HQPlayer window visibility query failed'};
 [FoliaHQWindow]::IsWindowVisible($_) -and -not [FoliaHQWindow]::IsIconic($_) -and $cloakStatus -eq 0
}).Count -gt 0;
ConvertTo-Json -Compress -InputObject @{running=($ids.Count -gt 0);visible=$shown;controllable=($panels.Count -gt 0)}`;
    try {
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
        const value = JSON.parse(stdout.trim());
        if (!value || ['running', 'visible', 'controllable'].some(key => typeof value[key] !== 'boolean')) throw new Error('Invalid visibility response');
        return { running: value.running, visible: value.visible, controllable: value.controllable };
    } catch { throw audioError('HQPLAYER_CONTROL_UNAVAILABLE', 'Cannot control HQPlayer window'); }
}
module.exports = { hqplayerWindow };
