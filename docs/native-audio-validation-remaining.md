# 后续验证报告 / Remaining validation

日期：2026-09-28，Asia/Shanghai。完整候选产品代码：`9b56b8d135065a6c3f7c87e8ff9512e63ae85daa`。本报告接续 [9 月 27 日补测](native-audio-validation-supplement.md)，对应用户指定的四项后续验证。

## 结论

四项均已执行，发现并修正三个产品问题：首次原生甲板挂载丢失播放意图、较晚完成的启动恢复覆盖新选曲目、Windows 旧文件清理失败导致已成功的更新误报失败。修正后完整 App 和迁移后的 A/B/C 分支分别复测通过。两首指定 FLAC 的严格转码仍失败，不能记为歌曲转码通过；输入文件未改写。

[截图与日志索引](native-audio-remaining-validation/index.html) · [逐步原始记录](native-audio-remaining-validation/records.json) · [SHA-256 清单](native-audio-remaining-validation/sha256-manifest.json)

| 后续项目 | 本轮结果 | 验证范围 |
| --- | --- | --- |
| Navidrome 首播 paused/IDLE | 稳定复现并修正；保存失败及通过截图、store 变更栈和 transport 调用栈 | React 开发模式首次挂载，以及启动缓存恢复与用户选曲的受控交错；不是只延长等待时间 |
| Spica、桜音 | 两首严格转码均再次失败；双后端原生容错播放通过，受控媒体故障后的转码失败及健康下一首恢复通过 | 12 个 App 步骤；明确区分自然转码拒绝与受控 DECODE_FAILED 事件 |
| 浏览器完整 App 基线 | 未修改上游与最终完整候选各 4 项通过 | 真正 Chrome 浏览器、无 Electron bridge；缓存播放/定位/暂停/续播、自然下一首、真实 HTTP 404、无效音频恢复 |
| ReplayGain 标签/缓存/切歌 | 完整候选 24 项通过 | 实际 FLAC 嵌入标签、生产 metadata worker、持久缓存、页面重载、切歌、App 到真实引擎；两后端 × 普通/整数 × track/album/off × 两首 |
| Windows 异常 | 修正后六项通过；A/B/C 各重跑六项 | 实际 Windows 文件锁、运行中的旧 exe、真实安装子进程中止、解锁后重试与新 exe 握手 |
| A/B/C 迁移 | 已迁移，分别运行类型、单测、UI 和硬件 App 回归 | 下面列出每个实际提交的独立结果，未把完整候选结果冒充各分支结果 |

## 首次播放失败的定位

本轮保存的失败是 `readyState=4 / paused=true / currentTime=0 / playerState=IDLE`。时序记录显示：App 自动播放 effect 调用第一个 `NativeAudioTransport.play()` 后，React StrictMode 的 layout-effect replay 重新执行 `NativeDeck` 挂载，销毁第一个 transport 并创建第二个。播放意图在第一次调用时已经消耗，第二个实例虽然准备成功却没有收到 play。栈中可以看到 `reappearLayoutEffects`，且新实例 session 与第一次 play 的 session 不同。

`PlaybackDeck.tsx` 现在在同一个微任务周期的 effect replay 中复用 transport；实际卸载仍释放资源，后端或处理模式改变仍创建新实例。新增组件回归用例断言首次挂载只发出一次 begin 和一次 play，并且播放时钟前进。A/B/C 各自的该用例均通过。

另一个竞争由延迟启动缓存读取稳定触发：用户已经开始播放 Ancient Magic，旧会话 Growing Up 随后恢复并覆盖它。`useSessionRestoreController` 增加恢复所有权检查；`restorePlaybackSourceForSong` 在异步返回后检查曲目是否仍属于本次恢复，过时 Blob 会释放。修正后同一受控顺序仍保持 Ancient Magic、PLAYING 和前进的时钟。

- [本轮首次挂载失败截图](native-audio-remaining-validation/complete/startup-race-1790607082511/user-play-before-restore-completes.png)：Ancient Magic，0 秒、IDLE，详见同目录 JSON 与 trace。
- [本轮失败时序](native-audio-remaining-validation/complete/startup-race-1790607192188/user-play-before-restore-completes-trace.json)：记录首次 play 与 StrictMode 重建的不同 session。
- [最终通过截图](native-audio-remaining-validation/complete/startup-race-1790608461813/late-restore-must-not-overwrite-user-play.png)：固定 Ancient Magic，晚到恢复不再覆盖，时钟超过 7 秒。
- [上一轮原始失败](native-audio-remaining-validation/complete/app-navidrome-1790457638923/navidrome-wasapi-exclusive-app-play.png)及后续两轮通过均保留在索引。旧记录没有调用栈，不能唯一判定那一次是上述哪条竞争；后续通过没有抹去它。

## 两首指定 FLAC

| 曲目 | Navidrome ID | 本轮源文件 SHA-256 |
| --- | --- | --- |
| HUMMING LIFE — Spica | `3B7IskPYaj5cXacvfgF6IS` | `17b28d5fa25a246c394e9732bc4fc5328467e72fb2b2f754b83186df9f2a722a` |
| ピコ — 桜音 | `0vkNVrR3Iqmso4JAUxoyDX` | `29b048e02276e16cf4db8e4b497081696a0bd3986f81d9b98918c241cf6bd0c4` |

两个哈希与上轮源文件及 raw 下载一致。本轮分别用客户端裁剪版、服务端完整版 FFmpeg，指定 `-xerror -map 0:a:0 -vn -sn -dn -c:a pcm_s24le -f null -`，四次均出现 `invalid sync code / invalid frame header`，退出码 `-1094995529`。实际生产转码服务对两首也再次返回 `FFMPEG_FAILED`。[音频严格解码证据](native-audio-remaining-validation/checks/remaining-strict-decode-audio-only.json)

原生输出准备使用的解码命令没有 `-xerror`，所以两首能在 WASAPI/ASIO 播放；这不证明输入无损或被跳过的错误帧不影响声音。不能用“能播放”推翻严格解码失败。App 恢复验证中主动发出媒体 DECODE_FAILED，随后实际生产转码失败，App 切到健康的 Growing Up 并继续播放；截图、事件来源和结果逐项保留。

第一次恢复测试错误地假设原生容错解码也会自然拒绝这两首，等待失败事件而超时。该轮标记 `HARNESS_EXPECTATION_WRONG`，保留截图，不作为原生播放缺陷。第一次直接 FFmpeg 命令未排除内嵌封面，裁剪版先因缺少视频 encoder 失败；该日志保留，但输入错误结论只使用后续明确选择音轨的复测。

## 浏览器与 ReplayGain

基线 checkout 是未修改的 `d2b84674ce83329c1d62a371305e691de20e0950`，tracked diff 为空。最终对照版本是 `9b56b8d`。两边使用相同 Chrome、完整 App、生成的无声 FLAC 和同一脚本，均没有 `window.electron.nativeAudio`。每边 4 项全通过；404 与坏音频端点均确实收到请求，恢复后仍以缓存 Blob 播放。这里没有重做上一轮真实 QQ 双甲板 automix 的输出波形验证，上一轮 automix 通过证据仍保持独立。

ReplayGain 本轮不向 currentSong 直接注入测试增益：先在生成的 FLAC 中写入真实 `REPLAYGAIN_TRACK_GAIN=-6/-3 dB`、`REPLAYGAIN_ALBUM_GAIN=-12 dB`、peak=0.8，再用生产 metadata worker 解析。测试准备阶段把解析结果和实际音频字节通过生产缓存 API 写入持久缓存；页面重载后，以不带 ReplayGain 的歌曲对象走 App 播放入口。逐次断言 Blob 缓存命中、当前曲目、真实 session 引擎增益和切歌后的新增益。

观测：track 增益为 `0.5011872 / 0.70794576`，album 为 `0.25118864`，off 为 `1`；volume=0.1 时 effectiveGain 对应为 `0.050118722 / 0.070794575 / 0.025118863 / 0.1`。完整候选 24 项全通过；A 的兼容模式抽测 4 项，B/C 的两种处理模式各抽测 8 项通过。

这验证真实文件标签解析与缓存/播放的串联，缓存的最初建立是测试准备；不冒充通过“导入文件夹”UI 或某在线平台自然返回标签的端到端过程。重载覆盖持久化读取，不覆盖操作系统重启、磁盘满、缓存淘汰所有组合。素材是无声测试文件，未做模拟输出或位透明测量。

## Windows 异常矩阵

| 场景 | 初始/修正后结果 |
| --- | --- |
| active.json 被外部进程持锁 | 安装拒绝 EPERM；旧 0.1.0 仍可用，解锁后升级、握手通过 |
| 新归档被独占锁 | 安装拒绝 EBUSY；旧版本仍可用，解锁重试通过 |
| 旧 exe 正在运行 | 安装新版本成功；未覆盖已映射的旧 exe |
| 待清理旧 exe 被持锁 | 初轮新 0.1.2 已激活却抛 EBUSY，属于产品缺陷；修正后延后清理，操作成功，解锁后重试完成清理 |
| 写入 active 前中止安装子进程 | 使用真实子进程，在实际文件 rename 前的测试检查点终止；旧 0.1.0 保持可用，重试成功 |
| 写入 active 后中止安装子进程 | 新 0.1.2 已激活且可用，重新运行安装和握手成功 |

文件锁由独立 PowerShell 进程打开真实文件产生，未 mock fs 错误。进程中断检查点只控制时序，文件操作仍为实际生产安装器。测试目录独立于用户组件和音乐库。两版保留目标在外部锁占用期间允许暂时多保留旧目录，后续操作重试清理；不承诺 Windows 能立即删除锁定文件。断电、磁盘满、第三方杀毒软件隔离尚不在本矩阵内。

## A/B/C 的实际提交与复测

| 分支 | 新提交 | 类型检查 | 相关单测 | UI | 独立真实 App 检查 | Windows |
| --- | --- | --- | --- | --- | --- | --- |
| A `codex/review-native-core` | `89dc9b8` | 通过 | 62 / 15 文件 | 6 | Navidrome 4、标签缓存 4、启动竞争 2 | 6 |
| B `codex/review-native-integer` | `b29850a` | 通过 | 62 / 15 文件 | 6 | Navidrome 4、标签缓存 8、启动竞争 2 | 6 |
| C `codex/review-native-signal-path` | `a554404` | 通过 | 63 / 16 文件 | 7 | Navidrome 4、标签缓存 8、启动竞争 2 | 6 |

各分支切换后重启 Vite 和 Electron 宿主，避免前端来自新分支、主进程仍来自旧分支。C 与最终完整候选的 `src / electron / .github / dev / test/component / test/unit / tsconfig.json` 内容一致。A 保留兼容模式边界，B 再加入整数模式，C 再加入链路 UI。

旧分支已另存为 `codex/snapshot-review-core-20260927`、`codex/snapshot-review-integer-20260927`、`codex/snapshot-review-signal-20260927`。新分支均为本地迁移，未推送。独立组件仍使用上一轮实际 0.1.2 构建及原有未提交源码修正，没有将它重新标记为已提交源码或官方发行版。

本轮还把离线证据中的不完整源码快照排除出主工程 TypeScript 扫描，避免档案内 `.ts` 被当作第二份项目编译。最终完整候选类型检查、63 项相关单测通过；新增 StrictMode UI 用例后完整 UI 为 7 项通过。

## 证据完整性与剩余边界

索引包含失败、通过、重跑和测试前提错误，不能把总行数当作独立通过用例数。原始 JSON 不改写；一次早期通过记录的返回值覆盖了步骤 id，归档时只关联原截图文件名，未伪造截图。一次截图超时前的部分标签测试不计为完整 24 项矩阵，后续完整运行才计入。

每个 App 运行保存当时的 commit/dirty 列表和脚本或关键源码哈希；较早记录没有的字段保持缺失，不用最终 HEAD 回填。Windows 和浏览器日志也保留各自执行上下文。凭据、授权音源 URL、账号 profile、原始音乐及安装目录不进入证据包。

用户指定的四类后续验证均已执行；严格转码的两首输入仍为失败，历史单次失败的唯一根因仍受旧日志粒度限制。官方镜像 CI、批准清单和正式发布仍需维护者环境，不在本轮本机验证结论内。

此外，本轮服务重新启动后的第一轮 WASAPI 曾返回一次 DEVICE_UNAVAILABLE；其时序与 paused/IDLE 无错误状态不同。后续完整候选及 A/B/C 的 WASAPI 均通过，但这一次的设备拒绝没有单独确定根因，原始记录和截图仍保留，未改标为脚本问题。

English: The four requested follow-up areas were exercised. Startup lifecycle, late restore, and locked-file cleanup defects were fixed and retested on the complete candidate and each migrated review branch. The two identified FLAC inputs still fail strict transcoding; tolerant native playback does not establish input integrity. Baseline browser checks and real-tag/persistent-cache gain checks passed within the documented boundaries. Historical failures and invalid test assumptions remain preserved.
