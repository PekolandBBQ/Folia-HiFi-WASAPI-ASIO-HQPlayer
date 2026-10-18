param([int]$ParentId,[string]$Installer,[string]$InstallDirectory,[string]$Application,[string]$ReadyFile,[string]$LogFile)
# The installer cannot touch running files: wait for Folia's normal exit and route cleanup.
$ErrorActionPreference = 'Stop'
function Write-Stage([string]$Message) { if ($LogFile) { Add-Content -LiteralPath $LogFile -Value ("$(Get-Date -Format o) $Message") -Encoding UTF8 } }
try {
    Write-Stage "helper-start parent=$ParentId"
    $running = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
    # Acquire the handle before readiness so normal parent exit cannot race handle acquisition.
    if ($running) { $null = $running.Handle }
    if ($ReadyFile) { [IO.File]::WriteAllText($ReadyFile, 'ready') }
    Write-Stage 'ready-waiting-for-normal-exit'
    if ($running -and -not $running.WaitForExit(120000)) { throw 'Folia did not finish normal exit within 120 seconds.' }
    Write-Stage 'parent-exited-starting-installer'
    $setup = Start-Process -FilePath $Installer -ArgumentList "/S /D=$InstallDirectory" -PassThru -Wait -WindowStyle Hidden
    Write-Stage "installer-exit=$($setup.ExitCode)"
    if ($setup.ExitCode -ne 0) { throw "Installer failed with exit code $($setup.ExitCode)." }
    if (-not (Test-Path -LiteralPath $Application)) { throw 'Installed application was not found.' }
    $restarted = Start-Process -FilePath $Application -WindowStyle Hidden -PassThru
    Write-Stage "application-restarted pid=$($restarted.Id)"
} catch { Write-Stage ("failed: " + $_.Exception.ToString()); exit 1 }
