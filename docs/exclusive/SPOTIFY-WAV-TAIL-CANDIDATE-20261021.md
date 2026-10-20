# Spotify / HQPlayer WAV 结尾交接候选版（2026-10-21）

本地候选版，未发布。沿用 AddressFix 候选的前端与 WAV 地址兼容修复。应用版本仍为 0.7.19；独立内部构建编号见 `build/wav-tail-candidate.json`，WAV 候选修订为 4。

运行文件：`C:\Users\Pekora\Documents\ChatGPT\Folia\artifacts\Folia-HiFi-Spotify-WAV-TailFix-20261021\win-unpacked\Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`。需要保留整个 `win-unpacked` 目录。没有修改用户配置、备份、已安装组件或已有候选包，没有控制正在运行的播放器。

## 保留的失败证据

运行日志 `C:\Users\Pekora\AppData\Roaming\Folia HiFi\logs\runtime\2026-10-20.log`，北京时间 2026-10-21 00:59:57：

- 《赴大荒》旧控制会话首次失败为 `TRACK_NOT_CURRENT`；清理再次以旧歌曲读取暂停，随后映射成 `ROUTE_SOURCE_PAUSE_UNCONFIRMED`。
- WAV 读取因此被 `owner-stop` 关闭。第二代采集累计 44,927,584 字节，独立读取累计 44,862,048 字节，仍有 65,536 字节（约 0.186 秒）未交给 HQPlayer；此数字不包括 HQPlayer 内部缓存和 DSP 延迟。
- 该次没有自然结束交接或下一首启动记录。原日志缺少切断前 HQPlayer 的位置和延迟，不能据此计算实际截掉的尾音。
- 用户确认本次 WAV 已可播放《赴大荒》，未听到此前 RAW 路径的类似爆音。该反馈不等同于所有歌曲与滤波配置的音质验收。

## 本次修改

1. 只读身份检查发现当前歌已变化时，保留错误与观察到的歌曲身份，但不先做暂停补偿、不立即把控制器锁为 cleanup-only。已发出命令后的真实失败仍走原恢复流程，设备、账号、进程、会话和采集代次检查保留。
2. 以播放确认得到的真实状态初始化自然结束时钟，覆盖从最后几百毫秒开始、首轮轮询前就结束的情况。EOF 检查与暂停之间发生换歌时，最多三次重新观察并交给明确的歌曲交接流程。
3. 自然结束停止旧采集，不取消旧输出代次；发现下一首身份后，不再把后续采集块当作旧歌曲发布。输入 EOF 与输出结束分别记录。正常尾音和高延迟 DSP 排空期间保留 HQPlayer 会话与 WAV 缓存。
4. 自然交接不再提前向界面发“暂停／下一首”。由当前原生输出的结束事件推进队列，避免过早停止输出和重复切歌。相同歌曲自然循环可在实际输出结束后，以新的读取代次重开采集。
5. 清理旧会话不向身份已变化的歌曲盲发暂停。明确的自然交接仍会在同一进程、设备和新歌曲身份得到确认后暂存 Spotify 的下一首，待旧输出结束再由 Folia 播放选择启动；这与旧失败的补偿暂停分开记录。迟到的旧会话 Stop / revoke 不能操作新会话。
6. WAV 组件尾部补零采用 HQPlayer 实际报告的输出延迟加原有 250 ms 余量，去除原有 3 秒截断；保留 PCM32 的采样率、样本、声道与已有配置。实际结束仍等待 HQPlayer 状态，不以补零写完或 HTTP 读完作为“已听完”。

## 验证与范围

- 针对性单元／集成测试记录：`build/wav-tail-boundaries.log`。
- 桌面交接协调器测试：`build/wav-tail-coordinator.log`。
- 类型检查（JavaScript 版 TypeScript，4 GB 内存上限）：`build/wav-tail-typecheck.log`。
- 实际候选 ASAR 模块及隔离组件检查：`build/wav-tail-package-verification.json`。使用真实本地命名管道与 HTTP，模拟 HQPlayer 控制状态，验证 5.5 秒延迟的完整补尾、输入 EOF 后输出保留、两次完整 WAV 读取及原 PCM 不变。该检查不代表真实 HQPlayer 实播。
- 真实设备监听和自动下一首：等待用户手动重开本候选后验证。原失败日志保留，不用后续通过覆盖原失败。

## 实播操作与日志

保持当前 HQPlayer 滤波／整形器设置，播放《赴大荒》最后 20–30 秒，之后不点下一首，等待尾音结束并自动连续进入后两首。再单独检查一次单曲循环。无需重装组件、重新配置或重新备份。

核对正常运行日志中的顺序：

- `SpotifyBridge / control-state / selection-transition`：旧、新歌曲身份、位置与 `pausePurpose`。
- `SpotifyBridge / control-original-failure` 的 `readOnlyIdentityChange`：明确标识无命令的换歌观察，以及 `observedTrackId`。
- `capture-boundary`：实际观察位置、时长、前缀帧与本次字节边界。
- `capture-end-identity-race`、`capture-complete-awaiting-output`：换歌竞态重读、实际发布字节与采集停妥事实。
- `SpotifyOutputEnd / capture-eof`：关闭输入之前的累计 PCM 与采集终点。
- `HQPlayer WAV HTTP / pcm-input-complete`：HQPlayer 报告延迟与补尾帧数。
- `SpotifyOutputEnd / output-draining` → `output-drained`：同一输出会话、代次的位置、延迟和结束事实；随后才应出现下一首的准备与 `deck-playing`。

用户操作界面；代理随后读取日志核对，不自动关闭或重新打开 Folia / Spotify / HQPlayer。
