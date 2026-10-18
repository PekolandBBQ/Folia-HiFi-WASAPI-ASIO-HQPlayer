param([int]$ParentId,[string]$Installer,[string]$InstallDirectory,[string]$Application,[string]$ReadyFile,[string]$LogFile,[switch]$Independent)
# The installer cannot touch running files: wait for Folia's normal exit and route cleanup.
$ErrorActionPreference = 'Stop'
function Write-Stage([string]$Message) {
    if (-not $LogFile) { return }
    # Reading diagnostics concurrently must not abort installation.
    try {
        $stream = [IO.File]::Open($LogFile, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes("$(Get-Date -Format o) $Message`r`n")
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    } catch { }
}
try {
    # Node's console child is terminated when its parent exits. Start the actual waiter
    # in its own hidden Windows console; readiness belongs to that independent process.
    if (-not $Independent) {
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
            '-ParentId', "$ParentId", '-Installer', $Installer, '-InstallDirectory', $InstallDirectory,
            '-Application', $Application, '-ReadyFile', $ReadyFile, '-LogFile', $LogFile, '-Independent')
        $quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $waiter = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $quoted -WindowStyle Hidden -PassThru
        $waiter.WaitForExit()
        exit $waiter.ExitCode
    }
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
