# test/manual/exclusiveInstallerReview.ps1
# Exercise the real NSIS installer, ZIP payload, and profile preservation.
$ErrorActionPreference = 'Stop'
$release = Get-Content packaging/exclusive/release.json -Raw | ConvertFrom-Json
$repoRoot = (Get-Location).Path
$buildRoot = Join-Path $repoRoot "release/folia-exclusive-$($release.version)"
$reviewRoot = Join-Path $repoRoot "test-results/stable-$($release.version)"
$installDir = Join-Path $reviewRoot 'installed app'
$zipDir = Join-Path $reviewRoot 'zip app'
$profile = Join-Path $env:APPDATA $release.profile
$legacyMarker = Join-Path (Join-Path $env:APPDATA $release.legacyProfile) 'installer-preservation-review.txt'
$legacyToken = if (Test-Path -LiteralPath $legacyMarker) { Get-Content -LiteralPath $legacyMarker -Raw } else { $null }
$installer = Join-Path $buildRoot "$($release.productName)-$($release.version)-win-x64-Setup.exe"
$archive = Join-Path $buildRoot "$($release.productName)-$($release.version)-win-x64.zip"
$exeName = "$($release.productName).exe"
$rows = [System.Collections.Generic.List[object]]::new()
function Record([string]$id, $detail) {
    $rows.Add([PSCustomObject]@{id=$id;status='PASS';detail=$detail})
    $rows | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $reviewRoot 'installer-results.json')
    Write-Output "PASS $id"
}
function Run-Installer {
    $process = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$installDir") -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exit code $($process.ExitCode)" }
}
function Assert-Payload([string]$destination) {
    $source = Join-Path $buildRoot 'win-unpacked'
    $files = Get-ChildItem -LiteralPath $source -File -Recurse
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
        $target = Join-Path $destination $relative
        if (!(Test-Path -LiteralPath $target)) { throw "Missing payload: $relative" }
        if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Payload differs: $relative" }
    }
    return $files.Count
}
if (Test-Path -LiteralPath $profile) { throw 'Existing profile: use an isolated Windows test account; do not alter user data.' }
if (Test-Path -LiteralPath $reviewRoot) { throw 'Review directory already exists; preserve earlier evidence and choose a fresh run.' }
$existing = Get-ItemProperty HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$($release.productName)*" -or $_.DisplayName -like 'Folia Exclusive HiFi*' }
if ($existing) { throw 'Existing fork installation: use an isolated Windows test account.' }
New-Item -ItemType Directory -Path $reviewRoot | Out-Null
try {
    Run-Installer
    $count = Assert-Payload $installDir
    Record 'fresh-current-user-install-and-payload-hashes' @{files=$count}
    $entry = Get-ItemProperty HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/* | Where-Object DisplayName -like "$($release.productName)*"
    if ($entry.DisplayVersion -ne $release.version -or !$entry.UninstallString.Contains($installDir)) { throw 'Missing or invalid uninstall registration' }
    $shortcut = Join-Path $env:APPDATA "Microsoft/Windows/Start Menu/Programs/$($release.productName).lnk"
    if (!(Test-Path -LiteralPath $shortcut)) { throw 'Start Menu shortcut missing' }
    Record 'version-uninstall-entry-and-start-menu' @{version=$entry.DisplayVersion}
    $env:FOLIA_REVIEW_EXE = Join-Path $installDir $exeName
    $env:FOLIA_REVIEW_OUTPUT = Join-Path $reviewRoot 'installed-settings'
    & node test/manual/exclusiveReleaseSmoke.cjs *> (Join-Path $reviewRoot 'installed-settings.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installed application settings review failed' }
    Record 'installed-application-settings' @{checks=10}
    if ($legacyToken) {
        $copiedMarker = Join-Path $profile 'installer-preservation-review.txt'
        if ((Get-Content -LiteralPath $copiedMarker -Raw) -ne $legacyToken -or (Get-Content -LiteralPath $legacyMarker -Raw) -ne $legacyToken) { throw 'Profile migration failed to preserve the legacy marker' }
        Record 'legacy-profile-copied-and-original-preserved' @{}
    }
    $marker = Join-Path $profile 'installer-preservation-review.txt'
    $token = [Guid]::NewGuid().ToString()
    Set-Content -LiteralPath $marker -Value $token
    Run-Installer
    if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne $token) { throw 'Reinstall changed profile marker' }
    $count = Assert-Payload $installDir
    Record 'same-version-reinstall-preserves-profile-and-payload' @{files=$count}
    $uninstaller = Join-Path $installDir "Uninstall $($release.productName).exe"
    $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Uninstaller exit code $($process.ExitCode)" }
    if (Test-Path -LiteralPath (Join-Path $installDir $exeName)) { throw 'Uninstall left application executable' }
    if (Test-Path -LiteralPath $shortcut) { throw 'Uninstall left shortcut' }
    $entry = Get-ItemProperty HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/* | Where-Object DisplayName -like "$($release.productName)*"
    if ($entry) { throw 'Uninstall left registry entry' }
    if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne $token) { throw 'Uninstall changed profile marker' }
    Record 'uninstall-removes-registration-and-preserves-profile' @{}
    Expand-Archive -LiteralPath $archive -DestinationPath $zipDir
    $count = Assert-Payload $zipDir
    Record 'zip-and-installer-identical-payload' @{files=$count}
    $env:FOLIA_REVIEW_EXE = Join-Path $zipDir $exeName
    $env:FOLIA_REVIEW_OUTPUT = Join-Path $reviewRoot 'zip-playback'
    & node test/manual/exclusivePlaybackReview.cjs *> (Join-Path $reviewRoot 'zip-playback.log')
    if ($LASTEXITCODE -ne 0) { throw 'ZIP playback review failed' }
    Record 'zip-real-playback-and-shared-profile' @{checks=15;profileMarker=((Get-Content -LiteralPath $marker -Raw).Trim() -eq $token)}
} catch {
    $_ | Out-String | Set-Content -Encoding utf8 (Join-Path $reviewRoot 'failure.txt')
    throw
} finally {
    Remove-Item Env:FOLIA_REVIEW_EXE,Env:FOLIA_REVIEW_OUTPUT -ErrorAction SilentlyContinue
}
