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
$running=@(Get-Process Spotify -ErrorAction SilentlyContinue | ForEach-Object {
 try{@{pid=$_.Id;exe=$_.Path;started=$_.StartTime.ToUniversalTime().ToString('o')}}catch{}
})
@{candidates=@($candidates);running=$running;errors=$errors}|ConvertTo-Json -Depth 4 -Compress
