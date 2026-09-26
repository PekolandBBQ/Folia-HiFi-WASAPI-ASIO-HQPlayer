# Windows 原生音频专项验证报告

日期：2026-09-27。基础：Folia 0.7.8 / `d2b8467`，工作分支 `codex/native-component-stage1`；独立组件 0.1.1、协议 v1。此报告记录本机候选实现，不代表作者批准、正式发布或所有设备兼容。

Date: 2026-09-27. Local review candidate based on Folia 0.7.8; component 0.1.1, protocol v1. This is not upstream approval or a production release.

## 结论

网易云、QQ、酷狗真实账号音源均已通过完整准备、WASAPI/ASIO 播放、暂停和定位。三平台均完成受控 403 → 原恢复控制器 → 真实音源重解析 → 硬件播放。Navidrome 原始 FLAC、服务端 MP3 和 Folia 转码缓存协议均有两种后端通过记录。

QQ 搜索入口曾返回空列表；用户提供可读取的歌单后，已用《自无垠处归航之星》（FLAC 48 kHz/24-bit）补齐远程、完整缓存和受控过期刷新在两种后端的验证。三平台均有完整缓存实播记录。

仍不能称为全部验证完成：扩大 Navidrome 随机样本时出现一次未定位的 `FFMPEG_FAILED`，当次脚本没有保留样本身份，不能宣布修复。随后改用同一首确定的 FLAC 控制变量验证三条路径，均通过。官方镜像 CI 尚未运行。三个本地审查分支已拆好，未创建集成 PR。

Real provider playback, complete cached sources and controlled expiry recovery passed on both backends. QQ cached-source coverage was completed using the user's playlist after the search entry returned no results. One random Navidrome transcode failed without enough sample identity to diagnose it; a subsequent controlled FLAC comparison passed. Three stacked local review branches are prepared; production mirroring and GitHub integration PRs have not run.

## 用户六项要求的实际状态

| 要求 | 状态 | 证据或边界 |
| --- | --- | --- |
| FFmpeg PCM 补丁 PR | 已提交 | [folia-ffmpeg-build PR #1](https://github.com/chthollyphile/folia-ffmpeg-build/pull/1)，未重复创建 |
| 三平台登录辅助 | 完成 | 原有登录 UI、隔离 profile、`startNativeAudioReview.ps1`；三平台 `omni.getLoginStatus` 均成功 |
| Navidrome 部署并加载目录 | 完成 | v0.64.2，仅监听 127.0.0.1:14533；用户授权 D:\Music 后配置读取，数据库记录 2,157 首；未对源音乐执行写入命令 |
| 逐项修改与专项测试 | 主体完成，保留未完成项 | 150 项相关单测、6 项 UI 测试通过；真实音源/故障注入/环境失败分别归档；详见限制 |
| 日志先中文后英文 | 已接入本次新增路径 | 组件错误、宿主诊断、步骤记录与验证脚本；未批量重写项目既有日志 |
| 崩溃/超时恢复 | 已实现并测试 | 默认自动返回 Web 并取消原生输出选择；关闭自动回退后提供重试、默认播放、上一组件版本 |

## 维护者要求对照

依据 [最新技术意见](https://github.com/chthollyphile/folia-major/issues/353#issuecomment-5847747280)。

| 要求 | 实现与验证 |
| --- | --- |
| 主进程不能绕过应用 Cookie | 下载改用所属 `webContents.session.fetch`，`credentials: include`；真实 Electron 请求携带测试 Cookie 已观察到 |
| 链接过期刷新 | 固定 `SOURCE_EXPIRED` / `SOURCE_UNAVAILABLE` 交给 App 原有恢复路径，Omni 保持唯一普通在线入口；受控 403 三平台通过，限制重复刷新单测通过 |
| Navidrome 转码源 | 只接受严格 `folia-transcode://media/<64hex>/audio.flac|wav`；使用所属 Electron session 分发协议，实际 96 kHz/24-bit FLAC 缓存源通过 |
| 兼容旧版与更新提示 | 清单保留兼容版本；`updateAvailable` 提示更新；CI 保留策略检查；真实 0.1.0→0.1.1→0.1.0 握手通过 |
| 固定错误码与翻译 | 组件响应/错误事件只返回固定码，未知码收敛；中文、英文、印尼文提示；原文只进入诊断日志，脱敏 URL/凭据 |
| Folia 官方分发 | 客户端只允许 Folia release URL；新增固定候选下载→校验→握手→Folia release 的手动 CI。候选为空，尚未远程执行 |
| 暂停与事件频率 | RFC 改为“暂停时可以释放”；记录约 40 ms / 25 Hz、命令可触发额外状态、不保证严格间隔 |
| 崩溃/超时策略 | 15 秒 RPC 期限；超时终止进程；停止清理不重启崩溃进程；只对崩溃和超时执行自动回退 |
| 磁盘只保留两版 | 激活/上一版指针、可逆停用、限定目录清理；三次安装保留两版的单测通过 |
| 主仓库仅接入代码 | .NET 源码/构建仍在独立组件仓库；普通浏览器路径及应用标识维持原有方式 |
| 独占格式协商与 ReplayGain | 既有组件化工作保留 WAVEFORMATEXTENSIBLE 与 ReplayGain；本轮补跑格式/整数样本和 ReplayGain 回归 |
| 整数模式、链路展示拆 PR | 已准备 A 基础、B 整数、C 链路三个本地依赖分支，每个分支分别测试；未发集成 PR，见 [拆分说明](native-audio-pr-series.md) |

## 环境与方法

- Windows x64，XingCore USB Audio：WASAPI 独占与 ASIO。测试音量为 0.1，仅检查驱动状态和时钟前进，没有测量 DAC 模拟输出。
- Folia 音频准备与 `folia-transcode` 使用加 PCM24/PCM32 的官方裁剪版 FFmpeg；Navidrome 是独立测试服务器，使用本机已有完整版 FFmpeg 执行其 MP3 转码，两者没有混入同一客户端包。
- 本地文件不做标签写回、不移动、不删除。Navidrome 数据库和转码缓存位于隔离测试目录。
- 在线测试经 Omni，Navidrome 经 Subsonic service。账号、token、带授权参数的音源 URL 和完整运行时日志不进入报告。
- 403 是本机可控端点注入；恢复控制器及后续平台源是真实调用。不是等待平台 URL 自然过期，也不是用静音 HTTP 文件替代账号测试。
- UI 恢复测试使用模拟 native bridge，真正渲染 Folia 组件；进程 crash/timeout 单测使用可控子进程对象；版本切换另用真实组件可执行文件验证。
- 完整缓存测试使用真实下载完成的 Blob 经生产加载器传输；不是持久 IndexedDB 缓存全生命周期测试。

Evidence classes are intentionally separate: live provider/hardware, injected HTTP expiry, mocked process/UI failures, real executable upgrade/rollback, and sample-level PCM tests. No DAC bit-perfect or audible-quality claim is made.

## 真实音源结果

| 音源 | 请求/实际 | WASAPI | ASIO | 补充 |
| --- | --- | --- | --- | --- |
| 网易云 | Hi-Res 请求；样本 FLAC 44.1 kHz/24-bit | 通过 | 通过 | 403 刷新、完整 Blob 两后端通过 |
| QQ | Hi-Res 请求；适配器返回 lossless，FLAC 44.1/48 kHz、24-bit | 通过 | 通过 | 403 刷新、完整 Blob 两后端通过；使用用户歌单绕过空搜索入口 |
| 酷狗 | Hi-Res 请求；样本 FLAC 44.1 kHz/24-bit | 通过 | 通过 | 403 刷新、完整 Blob 两后端通过 |
| Navidrome 原始 | FLAC，覆盖 44.1/48/96 kHz 样本 | 通过 | 通过 | 最终控制变量样本为同一首 48 kHz/24-bit FLAC |
| Navidrome 服务端 MP3 | 完整 MP3 响应，44.1/48 kHz 样本 | 通过 | 通过 | 初始缺 FFmpeg 的失败保留；补齐服务器环境后通过 |
| Navidrome `folia-transcode:` | Folia 转码成 FLAC，覆盖 48/96 kHz、24-bit | 通过记录 | 通过记录 | 另有一次随机样本失败尚不能归因，不能扩大为全曲库通过 |

一次三平台无截图插入阶段的完整准备时间：网易云 WASAPI 937 ms / ASIO 782 ms；QQ 1,315 / 865 ms；酷狗 642 / 699 ms。这是少量样本，含本机和网络缓存影响，不是性能基准。逐步骤截图会增加 `elapsedMs`，不能据此判断解码变慢；数据中的 `preparationMs` 单独记录准备耗时。

The selected online samples were 44.1 or 48 kHz/24-bit FLAC despite the requested Hi-Res tier. QQ currently exposes FLAC rather than a separate Hi-Res tier. Preparation timings are illustrative observations, not benchmarks.

## 自动检查

| 检查 | 结果 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| nativeAudio、在线恢复、转码、ReplayGain、命令面板/存储/翻译合同相关单测 | 150 / 150 通过，19 个文件 |
| 原生组件浏览器 UI | 6 / 6 通过：自动回退、三选项与重试、手动 Web、手动旧版、设备/控制、链路响应式布局 |
| C# 样本/格式测试 | 7 个边界样本 × 5 个增益、EOF 静音、PCM16/24/32 extensible 描述通过 |
| FFmpeg 精度 | 96 kHz PCM24 → FLAC → PCM32 的 10 个有符号边界样本逐值一致 |
| 真实组件版本 | 0.1.0 安装握手 → 0.1.1 升级握手 → 0.1.0 回退握手通过 |
| 清单地址与兼容版本策略 | 本地脚本通过；workflow YAML 解析通过；上游远程 CI 未运行 |

没有把旧的全量测试统计复用成本轮结果。本轮不是所有 Folia 功能的全量回归；此前 Windows 符号链接权限问题也没有被修改或掩盖。

## 失败记录及修正

1. Navidrome 初始 MP3 失败：服务器 PATH 找不到 FFmpeg。配置 `FFmpegPath` 后通过。原始 `DECODE_FAILED` 界面码是客户端读到无有效音频的结果，并不是 ASIO 不支持 MP3。
2. Folia 转码初始 `FFMPEG_UNAVAILABLE`：隔离入口的专用音频运行时未配置；补齐官方音频运行时后通过。
3. 测试脚本第一次读取转码结果为 `result.url`，真实合同是 `result.representation.url`；修正测试脚本，未更改产品合同。
4. 首次 403 验证脚本只检查 `Error.code`。Electron contextBridge 不保留该自定义属性，但固定码在 `message`；改用产品已有错误码解析器后通过。
5. UI 探针在 StrictMode 模拟卸载时提前撤销 Blob URL，导致 Web 回退报格式错误；修复探针资源生命周期。另一个用例断言的按钮文字与翻译不一致，改正断言后通过。
6. 后续 QQ 搜索/喜欢列表为空，账号状态仍有效；没有反复要求用户登录，没有判断为风控或账号失效。用户打开歌单后，Omni 成功取得歌曲并完成全部缓存补测；历史受阻记录保留。
7. 扩大 Navidrome 随机样本时发生一次 `FFMPEG_FAILED`，旧脚本未保存该样本身份，不能追溯其确切格式。脚本已改为固定同一首 FLAC 并记录 trackId/suffix，最终三路径通过；这不证明那次随机失败已修复。
8. 准备失败后的清理曾向尚未加载该 session 的组件发 stop，产生无意义的设备错误诊断；宿主现在仅对已提交 load 的会话发 stop，取消/停止单测通过。
9. 拆分时扩展合同测试发现回退命令含项目禁止的拼音缩写、命令快照未更新；删除缩写并仅补入新命令。拆分脚本还曾因印尼文缩进不同而漏保留基础翻译，已恢复并新增三语言设置/错误码合同测试。没有放宽现有断言。
10. QQ 补测期间开发热更新使测试动态导入的无时间戳 store 与恢复控制器使用的带 `?t=` store 不同。测试脚本读到空地址，却只根据恢复函数返回值判定成功，后续播放因空地址失败。重启 Vite 和隔离窗口、增加有效刷新地址断言后重跑全部 QQ 路径通过；该轮原始截图保留，证据索引标记 `HARNESS_INVALID`，不作产品成功或失败依据。没有修改产品恢复控制器来迎合测试。

## 本地审查分支

| 范围 | 本地分支 / 提交 | 分支独立检查 |
| --- | --- | --- |
| A 基础组件与恢复 | `codex/review-native-core` / `17877fe` | 类型检查、149 项单测、5 项 UI 测试通过 |
| B 可选整数 PCM | `codex/review-native-integer` / `ed69851` | 类型检查、119 项相关单测、5 项 UI 测试通过 |
| C 可选链路展示 | `codex/review-native-signal-path` / `839d82e` | 类型检查、120 项相关单测、6 项 UI 测试通过 |

这是依次叠加的审查分支，不是三份互不依赖的实现；测试数有重叠，不相加。硬件实播来自完整验证版，分支独立检查为类型、单元和 UI 测试，没有冒充每个分支都独立重跑硬件。分支内的完整报告是拆分时快照，本文件是更新后的总报告。

The stacked branches were independently checked. Counts overlap and are not additive. Real hardware results belong to the complete validation candidate; branch-specific runs are type, unit and UI checks.

## 截图与可复现资料

本机生成的 [完整可筛选证据报告](native-audio-validation/index.html) 包含所有保留轮次、每个结果的 JSON 和对应 PNG，以及产品恢复对话框截图。该目录是生成物，不进入源码 PR；运行 `node test/manual/buildNativeAudioReviewReport.cjs` 可重新整理现有证据。对外分享应使用脱敏证据压缩包，不上传账号 profile 或完整 Electron 日志。

测试命令：

```powershell
./test/manual/startNativeAudioReview.ps1 -Restart
node test/manual/nativeAudioProviderReview.cjs
# 搜索返回空时，可指定用户已提供的歌单；必须同时指定平台。
node test/manual/nativeAudioProviderReview.cjs --provider=qq --playlist=<playlist-id>
node test/manual/nativeAudioProviderReview.cjs --navidrome
node test/manual/nativeAudioVersionReview.cjs
node test/manual/nativeAudioPrecision.cjs
node test/manual/buildNativeAudioReviewReport.cjs
```

主进程修改必须重启 Electron；只是刷新页面不够。长期热更新后进行 CDP 模块级测试，应先重启 Vite 和验证窗口，避免测试动态导入不同的 store 实例。截图里的“专项验证记录”是测试脚本展示的返回数据，明确属于测试界面，不是新增产品功能；历史无效测试轮次已另行标注。

## 尚未完成与提交边界

1. 各平台全部音质档位、自然过期、长时播放/断网重连和更广设备矩阵仍需补测；已完成的缓存实播是完整内存 Blob 路径，未覆盖所有 IndexedDB 淘汰/重启恢复行为。
2. Navidrome 随机转码失败需要重新捕捉到可定位样本。现有少量通过样本不能宣称整个 D:\Music 转码全兼容。
3. 生产候选清单、Folia 官方镜像发布、官方 FFmpeg 新版哈希、真实公开 CI 均待实际发布条件满足；本地构建不替代这一步。
4. A/B/C 本地审查分支已准备，但尚未推送这批新分支、创建集成 PR 或再次发送 Issue 回复。FFmpeg PR 是本轮唯一已提交的 PR。

Pending work is explicitly retained rather than marked PASS. The evidence supports continued review, not an unconditional production-readiness claim.
