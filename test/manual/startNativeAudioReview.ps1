param([switch]$Restart)
# test/manual/startNativeAudioReview.ps1 — isolated local validation, preserves signed-in accounts.
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskReview = Join-Path $env:LOCALAPPDATA 'FoliaNativeReview'
New-Item -ItemType Directory -Force -Path $taskReview | Out-Null
$taskStatePath = Join-Path $taskReview 'processes.json'
$taskState = if (Test-Path -LiteralPath $taskStatePath) { Get-Content -Raw $taskStatePath | ConvertFrom-Json } else { [pscustomobject]@{ electronPid = 0 } }
$taskExe = Join-Path $taskRoot 'node_modules/electron/dist/electron.exe'
$taskRunning = Get-Process -Id $taskState.electronPid -ErrorAction SilentlyContinue
if ($taskRunning -and $taskRunning.Path -eq $taskExe) {
    if (!$Restart) { Write-Output '验证窗口已运行 / Review window already running'; return }
    Stop-Process -Id $taskRunning.Id
    $taskRunning.WaitForExit(5000) | Out-Null
}
if (!(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3000 --strictPort' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskReview 'vite-stdout.log') -RedirectStandardError (Join-Path $taskReview 'vite-stderr.log') | Out-Null
}
$taskDeadline = (Get-Date).AddSeconds(30)
while (!(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) {
    if ((Get-Date) -ge $taskDeadline) { throw '开发服务器启动超时 / Development server startup timed out' }
    Start-Sleep -Milliseconds 200
}
$env:FOLIA_REVIEW_DEBUG = '1'
$env:FOLIA_NATIVE_COMPONENT_CATALOG = (Resolve-Path (Join-Path $taskRoot '../folia-native-audio-component/artifacts/development-catalog.json')).Path
$env:FOLIA_NATIVE_FFMPEG_PATH = (Resolve-Path (Join-Path $taskRoot 'build/ffmpeg/win-x64/ffmpeg.exe')).Path
$env:FOLIA_TRANSCODE_FFMPEG_PATH = $env:FOLIA_NATIVE_FFMPEG_PATH
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$taskStamp = Get-Date -Format yyyyMMdd-HHmmss
$taskProcess = Start-Process -FilePath $taskExe -ArgumentList 'test/manual/nativeAudioReviewHost.cjs' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskReview "folia-$taskStamp-stdout.log") -RedirectStandardError (Join-Path $taskReview "folia-$taskStamp-stderr.log") -PassThru
$taskState.electronPid = $taskProcess.Id
$taskState | ConvertTo-Json | Set-Content -LiteralPath $taskStatePath
Write-Output "验证窗口已启动，账号配置保留 / Review window launched with preserved account profile: PID $($taskProcess.Id)"
