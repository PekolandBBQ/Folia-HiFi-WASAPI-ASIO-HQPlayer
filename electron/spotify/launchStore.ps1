param([string]$PackageFullName,[string]$Apps)
$ErrorActionPreference='Stop'
# Launch the chosen installed Store application, preserving the external asset path.
$packages=@(Get-AppxPackage -Name SpotifyAB.SpotifyMusic | Where-Object PackageFullName -eq $PackageFullName)
if($packages.Count -ne 1){throw 'Selected Spotify package changed'}
$manifest=Get-AppxPackageManifest -Package $packages[0]
$applications=@($manifest.Package.Applications.Application | Where-Object Id -eq 'Spotify')
if($applications.Count -ne 1){throw 'Spotify application entry missing'}
Add-Type -Path (Join-Path $PSScriptRoot 'StoreActivation.cs')
$aumid=$packages[0].PackageFamilyName+'!'+$applications[0].Id
$activationPid=[Folia.SpotifyDesktop.AppActivation]::Activate($aumid,$Apps)
@{activationPid=$activationPid}|ConvertTo-Json -Compress
