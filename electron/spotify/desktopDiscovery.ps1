$ErrorActionPreference='Stop'
# Read-only discovery: desktop installs and Store packages are independent candidates.
$candidates=@(); $errors=@()
$paths=@((Join-Path $env:APPDATA 'Spotify\Spotify.exe'),(Join-Path $env:LOCALAPPDATA 'Spotify\Spotify.exe'),(Join-Path $env:ProgramFiles 'Spotify\Spotify.exe'))
if(${env:ProgramFiles(x86)}){$paths+=Join-Path ${env:ProgramFiles(x86)} 'Spotify\Spotify.exe'}
foreach($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Spotify.exe','HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Spotify.exe')){
 if(Test-Path $key){$value=(Get-Item $key).GetValue('');if($value){$paths+=$value.Trim('"')}}
}
foreach($p in @($paths|Sort-Object -Unique)){if(Test-Path -LiteralPath $p -PathType Leaf){$candidates+=@{id='desktop:'+$p;layout='desktop';exe=$p;prefs=(Join-Path $env:APPDATA 'Spotify\prefs');version=(Get-Item -LiteralPath $p).VersionInfo.FileVersion}}}
try{foreach($pkg in @(Get-AppxPackage -Name SpotifyAB.SpotifyMusic)){
 $exe=Join-Path $pkg.InstallLocation 'Spotify.exe'
 $candidates+=@{id='store:'+$pkg.PackageFamilyName;layout='store';exe=$exe;prefs=(Join-Path $env:LOCALAPPDATA ('Packages\'+$pkg.PackageFamilyName+'\LocalState\Spotify\prefs'));version=$pkg.Version.ToString();packageFullName=$pkg.PackageFullName;available=(Test-Path -LiteralPath $exe)}
}}catch{$errors+='STORE_DISCOVERY_UNAVAILABLE'}
$processInfo=@{};try{Get-CimInstance Win32_Process -Filter "name='Spotify.exe'" | ForEach-Object {$processInfo[[int]$_.ProcessId]=$_.CommandLine}}catch{}
$running=@(Get-Process Spotify -ErrorAction SilentlyContinue | ForEach-Object {
 try{
  $line=$processInfo[[int]$_.Id];$asset=$null
  if($line -match '"--app-directory=([^"]+)"|--app-directory(?:=|\s+)(?:"([^"]+)"|(\S+))'){$asset=if($Matches[1]){$Matches[1]}elseif($Matches[2]){$Matches[2]}else{$Matches[3]}}
  @{pid=$_.Id;exe=$_.Path;started=$_.StartTime.ToUniversalTime().ToString('o');commandLineKnown=[bool]$line;mainProcess=([bool]$line -and $line -notmatch '--type=');appDirectory=$asset}
 }catch{}
})
@{candidates=@($candidates);running=$running;errors=$errors}|ConvertTo-Json -Depth 4 -Compress
