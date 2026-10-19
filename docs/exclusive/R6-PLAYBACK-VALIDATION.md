# r6 播放交接与循环验证（进行中）

2026-10-19。分支 `codex/r6-spotify-playback`，保留用户配置及组件备份，未发布。

## 已完成

- Wrapper 1.1.3 增加循环能力握手、读取和写入回读；关闭／列表／单曲分别映射 0／1／2。随机播放独立于循环。
- 外部换歌先发送 Folia 确认框，再清理旧输出；旧清理与新点歌串行交接，连续换歌保留原 Folia 歌曲身份。
- 自然结束交由 Folia 队列处理，手动换歌提供追随、暂不追随、在 Spotify 中继续三个选择。
- 类型检查排除 build 等生成目录，避免扫描多份完整装配副本；本机原高内存 tsc 进程已停止。验证使用 GOMEMLIMIT=2GiB、GOMAXPROCS=4。
- 52 项 Node 测试、84 项定向 Vitest 通过，类型检查通过。

## 实际播放证据与失败

候选：`artifacts/Folia-HiFi-r6-validation-20261019/win-unpacked`。

- 本机 Spotify → WASAPI-exclusive，44.1 kHz 双声道 PCM，350 ms 预缓冲。原生 state 显示 playing=true、buffering=false，输出位置及缓冲范围持续推进。
- 循环按钮实际写入并回读 Spotify all、one、off；单曲循环 everscape 到末尾后重新播放；关闭循环后 everscape 自动进入《酸橙色信箋》，保持歌单页。
- 用户在桌面切歌后出现 Folia 风格确认框；connection.jsonl 记录 token=4、choice=follow，追随《A Promise Makes a Home》。但用户反馈并确认 **Folia 进度停住**，因此该分支不能算通过。
- 现场只读检查发现当前原生 transport seeking=true、position/currentTime=1.332，而同一 native session d122cba2-09ed-445c-8bb9-ef02fcdb88b3 的原生输出位置已到 95.532 秒。队列和加载 Promise 已完成。音频推进不能代替界面进度验收。
- 增加回归用例后复现：当前 checkpoint Seek 返回 CANCELLED 时，fail() 静默返回，setter 留下 seeking=true，receive() 持续丢弃 state 更新。已修正当前请求的取消收尾，恢复已确认的输出时钟；旧请求不能清除新请求状态。新增 NativeAudioSeek 日志用于下一轮确认实际取消分支。
- 该修复后的原生音频、流式播放、输出交接、metadata checkpoint 共 75 项通过。保留 `build/r6-seek-reproduction.log` 的修复前失败记录及 `build/r6-native-regression.log` 的通过记录。

## 待验证

- 修复后桌面换歌追随，歌曲、进度、歌词和实际输出同时推进。
- 暂不追随、在 Spotify 中继续、连续桌面换歌。
- 列表末尾 all 回到首首、off 停止，以及 Spotify 桌面反向修改循环模式。
- 最终装配、PR、GitHub/Gitee r6 发布尚未完成。不能将针对性测试等同于实播全部通过。

用户已指定后续界面操作由用户完成，代理只观察日志并提供步骤；不得自动关闭、重开或点击候选窗口。

## 外部 Seek 跟进

用户在 seek-fix 候选反馈：追随后进度已恢复，但操作 Spotify 进度条时 Folia 不跟随。检查确认观察器只比较 trackId，同一歌曲且非自然结束会直接返回，没有检测外部 Seek。

新增独立观察时钟；Folia 发出自己的控制变更时清除基线，避免把自己的 Seek 识别为外部输入。播放中同曲进度偏离预计时钟超过 1000 ms 时，经已有暂停采集、清理旧输出和重建播放入口对齐实际位置，不只是修改前端数字。自然结束优先使用循环处理；手动换歌仍走确认框。新日志 external-handoff 包含 externalSeek 和 positionMs。

54 项 Node、45 项定向 Vitest 与类型检查通过；新的外部 Seek 真实播放尚待用户验证。候选目录 `artifacts/Folia-HiFi-r6-external-seek-20261019/win-unpacked`。暂停状态下拖动 Spotify 尚未纳入此次自动追随，不冒充全部场景通过。

## 首播暂停确认失败：需要现场诊断

13:01:27 的准备请求在 13:01:48 三次重试耗尽；13:02:52 的另一首请求在 13:03:13 同样耗尽。没有进入 PCM 交付，桥接 1.1.3 握手已完成。旧日志仅记录 ROUTE_SOURCE_PAUSE_UNCONFIRMED，不能确定是远端未暂停、状态回读、歌曲身份还是旧会话清理失败。

已修复诊断链丢失：guarded 保留原始 cause 与独立 cleanupError，publicError 保留固定字段投影；普通运行日志启用 control-original-failure、control-state、route-request-failed。route-pause 汇总记录 before/after、acknowledged、observationCount、elapsedMs、outcome，失败不会再只留下外层错误。错误显示区分原始原因和清理原因。

132 项控制回归通过；新增诊断投影及外部交接测试通过。诊断候选 `artifacts/Folia-HiFi-r6-pause-diagnostic2-20261019/win-unpacked` 供用户复现一次。**此次只修复确认的诊断缺陷，尚未证明真实播放失败根因已修复。** 不发布，不操作用户窗口，不修改配置或备份。


## 2026-10-19 13:09 首播复现与原生活动状态遗漏

本次四次尝试（首次加三次重试）均在准备阶段失败，原始错误为 ROUTE_SOURCE_PAUSE_UNCONFIRMED；随后清理的 route-pause 均为 already-paused，Spotify 曲目 1Lv847HIia1BIqTQq149As 停在 38093 ms，isPlaying=false。未发现这次清理本身失败。不能再把该轮失败描述为 Spotify 暂停指令失败。

定位到 bindObservedRoute：即使 Wrapper 已确认暂停，仍重复 inspect 等待 Windows 音频会话非活动，4 秒后抛出同一错误。原生 Acquire 还有相同的 SourcePaused 检查，而内部 VerifyPaused 对进程采集早已使用 requireNativeQuiescence=false。此次统一两个前置边界：原生发现回报是否需要端点暂停观察；仅进程采集不再据此阻断。SourcePaused 原始值仍保留，不伪造暂停；实际源状态、绑定进程及独立采集停止检查仍执行。旧端点采集默认继续要求非活动。

新增 route-binding-observed 日志包含 sourcePlaying、nativeSourcePaused、requiresNativePauseObservation 与检查耗时；旧端点等待超时明确标注 route-native-inactivity 阶段。

验证：171 项播放控制/路由集成测试，55 项原生服务测试，111 项 Windows 组合测试通过（组合测试含只读接口探测，无实播/策略写入）。覆盖端点仍活动但源已暂停、旧端点采集拒绝活动状态，以及进程采集不能绕过真实源暂停。原生组件发布构建成功。此前测试没有覆盖进程模式下“端点长期活动、源已暂停”的准备入口组合，是本次漏项。

候选 artifacts/Folia-HiFi-r6-native-pause-fix-20261019/win-unpacked；包含重新编译的路由组件及配套清单。未改用户配置、备份或运行中的窗口，未发布。真实首次播放及外部 Seek 仍待用户重开验证，不能由上述自动测试代替。

## 2026-10-19 外部 Seek 导致下一首、外部暂停被自动恢复

13:17:02 的真实日志：メジャー在 173019/289333 ms（并非曲尾），暂停回读成功后原始失败 ROUTE_PROTOCOL_INVALID；约 323 ms 后 PlaybackSelection caller=NativeAudioTransport.receive → onEnded → handleNextTrack，自动请求ザイオン。13:18:08 LilaS 在 95444/246230 ms 同样发生。没有 external-handoff 成功事件。原因是同曲外部 Seek 被送到 holdExternalSelection，而该接口拒绝前后相同歌曲。停流后的设备 EOF 又先于失败清理冒充自然结束。

用户随后报告 Spotify 主动暂停却报错并续播。13:18:22 与 13:18:32 记录 playing-mismatch（expectedPlaying=true、actualPlaying=false），之后 confirm-play 将 Spotify 再次启动。原先观察器没有处理同曲暂停，运行检查将用户操作当成故障恢复。

修复：同曲 Seek/暂停采用已有 suspendPaused 保留路由，真正换歌才用 holdExternalSelection。观察器显式返回 externalPause；协调器停止输出后保持暂停，不 follow/advance，也不弹换歌确认。轮询两次读取间发生暂停时先重读交接，不直接触发播放故障。实时 PCM source 标记 live，只有生产者正常完成才接受设备 ended；普通文件流逻辑不变。观察器使用同一次读取记录的真实曲目/位置，兼容旧适配器跨曲投影位置为 0 的差异。

验证：234 项控制、路由集成、实时 PCM 和流会话测试；11 项交接协调器测试；受限资源类型检查；renderer 构建通过。新增同曲 Seek/暂停测试穿过真实控制器、路由编排与采集生命周期（外部组件模拟），不冒充硬件实播。保留前一轮原生暂停边界修复。候选 artifacts/Folia-HiFi-r6-external-controls-20261019/win-unpacked。用户自行关闭重开；待实测向前/向后拖动仍同曲、暂停至少 10 秒不被恢复。未发布，配置与备份未改。

## 2026-10-19 Spotify 暂停后续播漏跟随

用户确认外部 Seek/暂停已正常，但 Spotify 点继续后 Folia 停在暂停。13:26:24、13:26:33 交接均为 externalSeek=true，前后 trackId 相同；13:26:39 外部暂停停在 35484 ms。13:26:40/42/44/46 又重复外部暂停通知，说明暂停观察器仍在运行，不能归因为停止轮询。代码只识别暂停、同曲跳进度和换歌，未识别暂停到播放的转换；重复暂停还重置了观察基线。

增加已处理外部暂停状态：相同暂停只处理一次，后续同曲 playing=true 标记 externalResume，经已保留的路由暂停/交接后发送 follow，沿用实际位置恢复 Folia，不弹换歌框。外部续播写入 external-handoff 日志。暂停回读也使用同次样本的真实位置，避免旧适配器跨曲投影返回 0。

173 项控制/路由测试和 12 项协调器测试通过，类型检查通过；测试覆盖两次暂停轮询不重复通知、续播位置为 35000 ms 而非 0、无换歌命令。候选 artifacts/Folia-HiFi-r6-external-resume-20261019/win-unpacked。真实暂停后续播待用户重开验证；未发布，不关闭用户窗口，不改配置与备份。

## 2026-10-19 续播后被准备期暂停观察打断，以及更新说明提示

最新用户实播日志 runtime/2026-10-19.log：13:32:30、13:32:40、13:32:46 的 externalResume 后均有 PCM 交付，证实续播事件已接入。但 13:32:04.088 和 13:32:20.083 在新准备完成、首块 PCM 前被标为 externalPause，13:32:42.210 又在位置交接中被暂停。后台 observePausedExternalSelection 原先仅判断无 reader，把准备/换 reader 的临时空隙当成已暂停，且入队后未重新检查资格。

修复：后台观察仅在已确认外部暂停或消费者暂停完成后启动；队列真正执行时再次检查 reader 与暂停标记。新读取意图清除消费者暂停标记，保留真正的外部暂停/续播识别及原有清理检查。没有改动已通过的外部 Seek、换歌及格式边界。

新增应用内专版更新弹窗：展示 releaseNotes，同一构建每次运行只提示一次；关闭/稍后不下载，明确点击下载才调用下载接口；下载完再明确退出更新，沿用现有安装前确认和配置保留机制。不改更新源或自动安装策略。

验证：49 项路由集成/前端交接/更新提示测试、30 项协调器/更新下载/启动器测试通过；类型检查及 renderer 构建通过。新增准备期暂停观察回归和更新发现不下载、稍后不下载、显式下载/安装测试。自动测试为模拟外部边界，不代表本机实播或真实安装已通过；不重复其余已通过硬件用例。

候选 artifacts/Folia-HiFi-r6-resume-update-prompt-20261019/win-unpacked。不关闭用户窗口，配置及备份保留，先不发布。用户自行关闭旧版重开，仅需验证 Spotify 暂停后继续播放是否能持续跟随、不再意外暂停。

## 2026-10-19 用户完成最终复测并授权 r6 发布

用户完成 resume-update-prompt 候选复测后明确要求发布 r6。最新 runtime 日志（UTC 06:37:32、06:37:50、06:38:00）记录三次 externalResume，随后恢复 PCM 交付；暂停事件对应其间操作。本轮不重复已通过项目。报告上方历史“待验证/未发布”为各阶段快照，不能据此抹除当时失败，也不将用户本次确认扩大成所有硬件或循环边界穷举验证。正式发布复用用户测试的同一候选装配，保留现有配置和备份。
