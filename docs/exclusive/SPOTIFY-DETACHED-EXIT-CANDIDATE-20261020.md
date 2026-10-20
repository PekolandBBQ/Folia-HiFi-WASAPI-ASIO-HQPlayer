# Spotify 断连后跨音源清理候选 · 2026-10-20

后续手机接管测试证实，原生输出最终收尾仍可能再次调用旧 Spotify 暂停。本记录保留当时范围与证据；后续修复、完整收尾覆盖及新候选见 [Spotify 主动连接、跨源退出及 WAV 试听候选](SPOTIFY-HOME-WAV-CANDIDATE-20261020.md)。

基线为已发布的 0.7.19 r8；本轮不发布，不改仓库地址、配置、备份、Spotify 资源及原生二进制。界面操作由用户执行，代理读取日志核对。

## 实际失败与根因

本机 runtime/2026-10-20.log 在 UTC 13:33:37（本地 21:33:37）记录：Spotify 控制读数为 DEVICE_INACTIVE；正常操作和随后清理均无法取得本机暂停确认。原控制器只保留清理权限。13:34:17、13:35:25 的实际 leaveProvider 再次重试，同一旧会话仍失败；原生 release 返回 SOURCE_BROKER_FAILED。界面因此显示“Spotify 控制通道未能完成暂停状态读取，旧会话尚未清理”。

不是另一首 QQ/网易云歌曲不可用，也不只是 toast 没清掉。跨音源提交原先把“Spotify 远端状态可读且路由已恢复”作为无条件前提。本机采集即使停止，远端设备接管/控制断连仍导致原生恢复保留，错误持续阻止其他源提交。原生身份与恢复记录本身没有被证实失效，不能通过假报暂停或删除恢复记录解决。

## 修复

- 仅当前 Wrapper 的进程采集入口启用分离处理；其他旧采集入口保持原行为。
- 仍先取消旧 reader、撤销旧媒体、停止输出并执行原生恢复。若原生回执已经确认同一租约的恢复写入尚未开始，失败仅来自源控制读取/暂停，且原生采集宿主独立确认停止，则让其他音源继续提交。
- 保留同一个 Spotify 路由所有者、原恢复记录和真实失败；明确记录 routeRestored=false、captureStopped=true。不是恢复成功，也不向远端 Spotify 偷发播放/设备转移指令。
- 再次进入 Spotify 时，在登记新准备任务之前重试真实恢复，成功后才创建新会话。新点歌会取代旧的等待；取消、再次切源及账号失效会撤销旧请求，避免迟到恢复重新抢播。
- 旧会话退出后不再发布其晚到采集错误。Spotify 错误提示具有来源归属；新音源成功提交时只清理旧 Spotify 提示，不删除新源自己的错误。
- 采集停止失败、恢复写入结果不明、旧端点采集等不伪装成成功；这些仍保留具体失败。

日志新增 provider-exit-deferred（含会话、路由会话、原控制错误与恢复状态）及 provider-exit-recovered。既有 control-original-failure、SpotifyCleanup 与原生失败继续保留。

## 验证

- 相关 9 文件 157 项通过：真实 JS 控制器、准备、PCM owner、路由生命周期编排，源响应及原生回执为显式模拟。覆盖设备接管后退出、连续失败、停止失败后重试、返回 Spotify、恢复期间取消/切源/替换点歌，以及不误清其他源错误。
- 本机全量 9682 项通过、2 项原有跳过，825 文件通过、1 文件跳过。记录 build/spotify-detached-full-unit.log。jsdom 对既有 @layer 样式的解析诊断保留，不将其当作真实播放器报错；测试无失败、无未处理异步错误。
- 既有资源、桥接及恢复 Node 回归 146 项通过：build/spotify-detached-node.log。
- 类型检查和 renderer 构建通过：build/spotify-detached-typecheck-final2.log、build/spotify-detached-renderer.log。
- 新增返回 Spotify 的用例首次暴露自等待：准备任务过早登记进 pending，退出恢复等待了该准备本身。已经移到任务登记前，并补充等待期取消/替换。初次失败日志保留：build/spotify-detached-exit-first.log。
- 随后取消用例最初断言了原始 code，而边界实际返回 unavailable / nativeCode=CANCELLED；修正为验证实际公共协议并等待所有异步结果，重跑通过。相关初次日志保留，不冒充产品错误。

本轮尚无新候选的真实断连跨源实播结果；不把模拟控制/回执及测试数量算作实播通过。其他已通过的播放行为不重复测试。

## 交付与人工操作

独立 EXE：`artifacts/Folia-HiFi-Spotify-Detached-Exit-20261020/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`（相对于本机 Folia 工作区），内部构建 1792505043603。由最终 ASAR 同步外部脚本；新 renderer 与 providerExitRecovery 模块共同入包；原生组件和组件清单仍沿用 r8。

用户自行关闭旧 Folia 后打开此候选：

1. Spotify 播放后切换到另一播放设备，随后在 Folia 实际播放网易云或 QQ 歌曲；确认新源能播放、旧 Spotify 提示清掉。
2. Spotify 切回本机后，在 Folia 点播 Spotify；确认重新准备和播放，代理检查实际路由恢复及新会话日志。

如控制通道仍不可读，路由恢复继续保留待重试，不声称已经恢复。没有重装组件、重跑 backup 或覆盖已有备份。
