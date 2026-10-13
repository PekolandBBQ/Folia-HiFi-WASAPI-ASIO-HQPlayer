param([Parameter(Mandatory=$true)][string]$Installer)
# Only the signed vendor driver installer is elevated; Folia and Spicetify stay unelevated.
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Installer).Path
$process = Start-Process -FilePath $resolved -WorkingDirectory (Split-Path -Path $resolved) -Verb RunAs -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'DRIVER_INSTALLER_NOT_COMPLETED' }
