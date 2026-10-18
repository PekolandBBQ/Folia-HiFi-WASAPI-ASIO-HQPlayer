param([int]$ParentId,[string]$Installer,[string]$InstallDirectory,[string]$Application)
# The installer cannot touch running files: wait for Folia's normal exit and route cleanup.
$running = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
if ($running) { try { if (-not $running.WaitForExit(120000)) { exit 1 } } catch { exit 1 } }
$setup = Start-Process -FilePath $Installer -ArgumentList "/S /D=$InstallDirectory" -PassThru -Wait -WindowStyle Hidden
if ($setup.ExitCode -eq 0 -and (Test-Path -LiteralPath $Application)) { Start-Process -FilePath $Application -WindowStyle Hidden }
