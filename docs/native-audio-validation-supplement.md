# 原生音频补测报告 / Native audio supplemental validation

> **2026-09-28 更新：** 用户指定的后续验证 1–4 已执行，首次挂载、启动恢复和 Windows 清理误报已修正；A/B/C 已迁移并分别复测。两首指定 FLAC 仍无法严格转码。最新结论、失败和通过截图见 [后续验证报告](native-audio-validation-remaining.md)。以下保留 9 月 27 日历史记录。

日期：2026-09-27（北京时间）。这是对维护者 Issue #353 要求和上一份审计 A1–A10 的补证，不是“全部验收完成”或发布批准。

Date: 2026-09-27, Asia/Shanghai. This supplements the maintainer review and audit findings A1–A10; it is not complete acceptance or release approval.

## 当前结论 / Current conclusion

三平台在真实 App 中经过受控 HTTP 403、原有源刷新、重新加载和实际硬件播放的链路已通过。非零进度恢复、暂停意图、真实进程崩溃/超时、旧组件恢复播放、会话 Cookie 正反例和 ReplayGain 已补测。发现并修正了“刷新后 URL 不变，播放器没有重新加载/恢复播放”的产品缺陷，以及发布工作流未依赖验证任务的问题。

Real App recovery from controlled HTTP 403 passed for all three providers. Nonzero resume, pause intent, real process crash/timeout, previous-version playback, cookie boundaries and ReplayGain are now exercised. An unchanged refreshed URL could prevent reload/autoplay; that defect and a missing CI verification dependency were fixed.

**仍有未关闭项：** 一轮 Navidrome 首次 WASAPI 播放在 30 秒期限内保持 paused/IDLE；随后两轮同曲目、同后端均通过，目前不能可靠区分启动状态竞争与测试初始化竞争。浏览器 automix 已有当前完整 App 通过记录，但与未修改基线版本的 A/B 对比、全部 ReplayGain 标签/持久缓存生命周期、更新中断/文件占用异常矩阵，以及维护者环境的官方镜像 CI，仍没有完成验证。

**Open items:** one intermittent Navidrome first-play timeout, comparison against an unchanged upstream App, tagged-file/persistent-cache gain coverage, interrupted/locked-file update scenarios, and upstream mirror CI. Current-App browser automix passed; later passing runs do not erase the intermittent failure.

## 本轮执行与结果 / Execution and results

| 项目 / Area | 方法与结果 / Method and result | 边界 / Limit |
| --- | --- | --- |
| 网易云、QQ、酷狗 × WASAPI/ASIO | 每平台 8 个步骤通过：生产播放入口；真实 HTTP 403 后 App 自动刷新续播；3 秒处注入媒体错误后续播；3 秒暂停后恢复仍暂停。 / Eight steps per provider passed. | 403 是本机端点，不是等待 CDN 自然到期。非零进度故障注入为媒体错误事件，不能称为播放中 CDN 自然断流。 |
| Navidrome App 自动转码 | 固定 Growing Up，ID `32sKZLBKwLBsaPv1R0taFe`，原 HTTP 源 → DECODE_FAILED 媒体事件 → App 恢复控制器 → `folia-transcode:` → 双后端约 3 秒续播；两轮共 8 步通过。 / Two complete four-step runs passed. | 初轮 WASAPI 首次播放超时保留为未关闭项；不是自然解码故障触发。每后端清理 representation 注册表，避免拿缓存转码源冒充原始源。 |
| 真实 crash / timeout | 两后端各测试自动 crash、自动 RPC timeout、手动重试、返回 Web、上一版组件；共 10 个场景通过，另有 6 张实际恢复提示步骤截图。 / Ten real-process scenarios passed. | 只终止/挂起隔离 profile 的子进程。超时通过挂起进程并发送真实 RPC 触发，不是模拟桥接。 |
| 回退真实播放 | 组件 0.1.2 → 0.1.0；当前歌曲、约 3 秒进度、PLAYING、实际版本均断言；结束重新安装 0.1.2。 / Real rollback playback passed. | 不等于所有协议兼容版本或 A/B/C 各分支均做过硬件回归。 |
| Cookie 正反例 | 每后端独立随机 Cookie；无 Cookie HTTP 401→SOURCE_EXPIRED；应用 session 有 Cookie→48 kHz WAV 准备成功；各断言两次请求的 false/true。 / Two isolated negative/positive pairs passed. | 验证的是 Electron session 边界，不宣称三个平台都依赖同一种 Cookie 机制。 |
| ReplayGain | 双后端 × 普通/整数 × off/track/album/album 缺失回退/无标签，共 20 项通过。-6 dB→0.5011872，-12 dB→0.25118864；volume=0.1 时 effectiveGain≈0.05011872/0.02511886。 / Twenty App-to-engine checks passed. | 元数据在内存中受控注入，不修改源文件标签；尚未覆盖真实标签解析→持久缓存→切歌全链。非单位增益的整数模式不应描述为位透明。 |
| 无组件浏览器基线 | 停用组件后，通过原 App 播放入口测试播放、定位、暂停和单曲循环；另以两首 QQ 真实歌曲验证自动下一首、两个播放器同时发声状态及约 7.0266 秒 non-plain automix cue；installed=false、nativeEvents=0。 / Basic browser controls and real automix handoff passed. | 未与未修改基线运行相同 App 场景做 A/B；未覆盖所有浏览器失败恢复。这里只验证时钟/播放状态，不是输出波形测量。 |
| 格式与错误隔离 | C# 7 项格式候选测试、20 项错误释放策略测试通过；宿主 devices 拒绝后继续播放；实机拒绝旧 session 后当前时钟继续。 / Format and error isolation checks passed. | 设备只接受 extensible 的分支通过可控格式回调验证；没有伪称真实物理设备枚举故障。 |
| 硬件格式组合 | XingCore：44.1/48/96 kHz × WASAPI/ASIO × 普通/整数，共 12 项通过，包含暂停、定位、EOF、重播、旧 session 拒绝后续播。 / Twelve hardware combinations passed. | 渲染静音；不是听感、DAC 模拟输出或位完美测量。故意非法命令的错误日志属于预期。 |
| 自动检查 | Vitest 49 文件 / 532 测试通过；组件 UI 6 通过；TypeScript 检查通过；C# 35 增益样本与 EOF/描述头检查通过。 / Automated checks passed. | 这是相关测试集合，不宣称仓库所有测试都运行。 |

## 修正内容 / Fixes

1. **相同 URL 恢复：** `reloadRecoveredNativeSource` 仅在原生 transport 处于错误且返回地址未改变时重新加载；canplay 后检查当前元素和自动播放意图。暂停场景不会被强制播放。对应 transport 回归测试已补。
2. **发布门禁：** `prepare-mirror` 依赖 `verify`；手动运行需指定既有批准清单的基准 commit，使兼容版本保留检查不能绕过。新增三项工作流结构断言。
3. **格式策略可测试化：** 将现有独占格式选择与命令错误释放条件抽为组件 `AudioPolicies`，保留候选顺序；旧 session 返回 INVALID_REQUEST。组件构建版本为 0.1.2。
4. **测试工具：** 修正会话 Cookie 标记未隔离/未断言、旧组件错误字段、App 初始化与缓存 representation 前置条件；截图等待恢复提示动画。UI 测试使用独立 outputDir，防止清理硬件证据。步骤输出先中文后英文。
5. **浏览器交接测试：** 初次停用组件未等原生甲板卸载而返回通用错误；增加前置等待。下一轮过早在曲目身份切换时检查双甲板，实际过渡仍在准备；改为等待真实双甲板重叠和非预览 transition cue 后通过。两轮失败保留为测试设置/验收时序问题，不当成已证实的音频缺陷。

The changes target unchanged-URL recovery, CI dependency enforcement, testable format/error policies, and evidence/harness correctness. Browser playback logic is not changed by the URL-reload helper.

## Navidrome 转码失败定位 / Transcode failure investigation

扩大抽查实际取得 12 首：10 首转码通过（包括一个 DSF 样本），2 首 FLAC 失败；随后对失败两首定点复测仍失败，未删除失败记录。

Twelve real library samples yielded ten passes, including one DSF source, and two FLAC failures. Both failures reproduced in a targeted run.

| 曲目 | Navidrome ID | 源文件 SHA-256 |
| --- | --- | --- |
| HUMMING LIFE — Spica | `3B7IskPYaj5cXacvfgF6IS` | `17b28d5fa25a246c394e9732bc4fc5328467e72fb2b2f754b83186df9f2a722a` |
| ピコ — 桜音 | `0vkNVrR3Iqmso4JAUxoyDX` | `29b048e02276e16cf4db8e4b497081696a0bd3986f81d9b98918c241cf6bd0c4` |

原始文件位于 `D:\Music\QQMusic`。Navidrome raw HTTP 200 下载大小分别为 26,543,440 / 32,318,366 字节，SHA-256 与源文件完全一致。直接读取源文件，用客户端裁剪版和服务器所用完整版 FFmpeg 的 `-xerror -f null -` 严格解码均出现 `invalid sync code / invalid frame header`，退出码 `-1094995529`。证据支持这两份输入本身不能通过严格 FLAC 解码，而非此次下载改变了字节；不据此断言文件为什么变成这样，也不自动修复/重写文件。更早匿名失败缺少身份，仍不能证明就是这两首。

Raw download hashes match the local files exactly. Both slim and full FFmpeg builds fail strict local decoding with the same FLAC framing errors. This rules out byte changes during these downloads, but does not establish how the files acquired the errors or identify the older anonymous failure. Source files were not rewritten.

## 版本和证据 / Versions and evidence

- 宿主基于 `9a1bcce2d114259173ddcbb6a19efcd901ee08ed` 加本轮未提交改动；组件基于 `faa4081` 加本轮改动。每轮 environment.json 保留当时 dirty 文件、脚本/FFmpeg/组件哈希；后续文档修订不回填成历史代码版本。
- 0.1.2 包 SHA-256：`4a8f4ba66f1d8cf772b8bc14056b884000d9c9ca6780164a3e5f318b02ba9cc6`；可执行文件：`70c6c8246fd7b215913dc389c3ba114a9001672690f344f06a25101f3c1b6324`。
- 客户端 FFmpeg SHA-256：`d28a1c5730520de13dfe947f39366032a77eee5c4ba7e78b63fd82e409294cfb`。
- 新轮次：`app-qq-*`、`app-netease-*`、`app-kugou-*`、`app-navidrome-*`。JSON 与实际 App PNG 对应，Cookie/音源授权 URL 不进入证据。
- 初次随机抽查脚本把步骤 ID 覆盖为 track ID；原始 JSON 保留，归档器按原截图序号关联，不伪造截图。旧 219 条原始记录保持独立，包含历史失败和无效 harness。
- UI 默认输出目录曾清理临时证据：旧 219 条从已有 docs 归档恢复；清理前尚未归档的新运行不计入本报告结果，重新执行后才记录。
- [可筛选截图和日志索引](native-audio-validation/index.html)；`checks/supplement-*.log/json` 为本轮检查；`evidence/<run>/environment.json` 为运行清单。

Local dirty revisions are explicitly recorded. Historical evidence remains distinct from reruns. The report contains no credentials or authorized source URLs. Source files and account profiles are excluded from the evidence package.

## 尚需后续验证 / Remaining validation

1. 定位一次 Navidrome 首次播放 paused/IDLE 的间歇失败，保留失败截图和后续通过截图，不直接归类为脚本问题。
2. 浏览器完整 App 与未修改版本的基线对比及更多错误恢复；真实标签、切歌、缓存命中到引擎的 ReplayGain 综合场景。当前完整 App 的双甲板 automix/下一首已通过。
3. 文件占用、进程中断更新等 Windows 异常矩阵。无旧版和旧版被篡改的 rollback 单测已通过，但不能替代全部更新故障测试。
4. A/B/C 审查分支仍为前轮快照，需迁移本轮修正后分别复测；不得将当前完整分支结果归给那些旧快照。
5. 官方镜像 CI、批准清单与正式发布仍需维护者环境；本轮未推送、未代替用户回复、未新建集成 PR。

These remain open rather than being counted as passes. No new upstream post, push or integration PR was made in this supplemental run.
