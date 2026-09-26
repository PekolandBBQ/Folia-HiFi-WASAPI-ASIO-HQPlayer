# Windows 原生音频：组件化第一阶段

本地审查分支：`codex/native-component-stage1`，从原候选 `0363b91` 继续改造。上游基线为 `d2b8467`，包含 0.7.8。尚未推送此次改造、创建正式 PR 或发布组件。

## 使用和默认行为

使用原来的 Folia 应用、应用标识、音乐库、设置目录和更新渠道，不再提供另一个 Native Audio 版应用。普通构建不编译 .NET，也不打包原生组件。

「选项 → 播放控制 → 播放设备」下方的「Windows 本地音频输出」包含组件安装／更新、停用、设备选择、整数直通和音频链路开关。侧栏及命令面板可跳转；两个开关也有命令入口。

默认仍是浏览器播放，整数直通和音频链路展示均默认关闭。没有安装组件的用户继续原来的播放路径；Linux/macOS 不显示 Windows 组件入口。选择原生输出后，本地文件和已由现有服务解析的在线歌曲均进入原生链路；浏览器输出仍可随时选择。

**当前为本地验证版**：生产组件目录 `electron/nativeAudio/component-catalog.json` 暂为空，尚无已发布的组件 URL 和审核后的生产 SHA-256。安装按钮会明确显示未配置发布，而不会下载不明版本。正式开放安装还需要独立组件发布及官方 FFmpeg 新版发布后更新固定清单。

## 功能边界

- Windows x64，本地文件和在线音源，WASAPI 独占、已安装的 x64 ASIO 驱动。
- 使用既有本地库的 File/文件句柄；无 OS 路径时以 1 MiB 分块传递。源文件分块暂存上限 2 GiB，准备后的 WAV 上限 4 GiB。
- 在线音源沿用既有账号、音质选择和音源解析流程，HTTP(S) 音源完整下载后解码，已缓存的 blob 音源分块暂存后解码；准备全部成功才播放，切歌/停止会取消旧会话并释放临时文件。下载上限 2 GiB，下载失败不播放部分文件。
- 完整解码当前文件后播放；兼容模式准备 PCM24，整数模式准备 PCM32，不指定重采样或声道转换。临时文件随切歌、停止和正常退出释放；崩溃可能留下系统临时目录。
- 播放、暂停、跳转、单曲循环、普通队列、音量、静音、歌词同步。暂停释放设备，继续时重新打开。
- ReplayGain 沿用 Folia 的 off/track/album 设置、专辑到曲目回退和峰值保护计算，保持既有默认。极端标签的线性增益限制在 0–16（约 +24.08 dB 上限）。
- EQ、音效、频谱和自动混音仅在原生播放时绕过；浏览器后端行为保留。
- WASAPI 同采样率探测浮点及 PCM16/24/32，补充 PCM WAVEFORMATEXTENSIBLE。整数模式仅接受 PCM32；不支持就报错，不静默降级为浮点或共享模式。
- ASIO 使用驱动前几个输出通道及驱动缓冲，整数模式限定 NAudio 回报为 Int32LSB 的驱动。未承诺所有 ASIO 格式或所有设备可用。
- 首阶段不含 HQPlayer、Spotify/Apple Music、DSD/DoP、无缝播放或跨平台原生后端。这些既有探索保留在完整自用分支。

## 整数模式和链路展示

整数模式在解码准备之后，以整数 PCM 提供数据；100% 音量、ReplayGain 合并增益为 1 时复制采样字节。其他增益使用 Q16 定点运算并饱和保护，不擅自关闭 ReplayGain、静音或恢复最大音量。源文件的解码/位深转换与设备自身处理不包含在此逐字节保证内，因此不宣称全链路 bit-perfect。

听感参考（主观描述）：通常可使三频密度更加饱满并改善背景的透明度，在解析力较好的系统上，这种差异更易被察觉 。

该听感描述与工程验证分别呈现，不能作为普遍音质改善或盲测结论。

可选链路浮窗显示原文件编码/采样率/位深、兼容或整数处理、采样率是否改变、引擎格式、ReplayGain 与音量的合并增益、输出后端。没有回报的数据标为未知，不根据音质选择推测。显示引擎数据不代表 DAC 实测。窗口支持紧凑单列/双列、过渡、毛玻璃、键盘关闭，浮动按钮跟随控制框上沿。

## 组件和协议

辅助程序源码、.NET 构建和运行时许可已移到独立的本地仓库 `../folia-native-audio-component`。主仓库保留 Electron 管理/会话/解码协调、媒体适配器和设置/UI，不再存放 C# 源码或单独应用配置。

组件安装到 `userData/components/native-audio`，由 Folia 固定清单校验 SHA-256、平台和协议后激活。更新失败保留旧指针，停用只解除激活并保留版本目录便于恢复。普通 Folia 构建不依赖组件发布成功。

协议 v1 使用标准输入/输出 JSON Lines：请求 id、会话 id、版本握手和能力检查；会话隔离、取消和进程超时监管。状态约 40 ms 回报；WASAPI 设备时钟，ASIO 音频回调帧数减驱动延迟。前端最多外推 120 ms，防止旧状态造成歌词回退。刷新设备、参数错误或旧会话请求不释放正在播放的引擎；加载和当前传输失败才清理可能损坏的驱动状态。

详细提案见 [native-audio-component-rfc.md](native-audio-component-rfc.md)。

## 本地验证启动

在独立组件目录执行 `./build.ps1 -DotNet <dotnet.exe 路径>`；生成自包含组件 ZIP 和仅用于开发的 `artifacts/development-catalog.json`。用户无需安装 .NET SDK；目前 ZIP 约 29.4 MiB，不进入 Folia 默认包体。

主项目开发进程设置：

```powershell
$env:FOLIA_NATIVE_COMPONENT_CATALOG = (Resolve-Path ../folia-native-audio-component/artifacts/development-catalog.json).Path
# 如需覆盖解码器，只允许开发构建：
$env:FOLIA_NATIVE_FFMPEG_PATH = (Resolve-Path build/ffmpeg/win-x64/ffmpeg.exe).Path
npm run dev:electron
```

启动后到设置中安装组件。生产构建不接受上述本地组件目录覆盖。

解码器复用主程序 `resources/ffmpeg-audio/ffmpeg.exe`。对应官方构建仓库的本地改动在 `../folia-ffmpeg-component-build`：仅追加 folia 变体 PCM24/PCM32 编码并更新验证清单，没有 Gyan 下载逻辑。当前官方固定 release 尚未包含新编码，不能把现有生产下载成功等同于原生输出可用。

## 2026-09-26 验证

- TypeScript 类型检查通过。
- 全量单测 3,921 通过、1 跳过；1 个既有 mod 签名测试因 Windows 创建符号链接 EPERM 失败，未修改该测试以掩盖环境限制。
- 原生相关 17 项单测通过，覆盖会话、取消、上传、组件哈希/协议/路径/更新失败、遥测去重。
- Chromium 2 个组件测试通过：设备切换、整数开关、播放/暂停/跳转/换歌/返回浏览器，链路开关、源规格、增益、响应布局、背景模糊。
- .NET 独立测试：5 个增益下的 35 个边界采样、溢出饱和、EOF 静音及 PCM16/24/32 extensible 描述通过。
- 官方构建脚本的本地 Windows 交叉编译通过；本地因缺 nasm 仅加 `--disable-x86asm`，该验证选项未提交到官方构建脚本。PCM24/32 编码存在；96 kHz PCM24 → FLAC → PCM32 的 10 个有符号边界采样保持一致。
- XingCore：WASAPI/ASIO × 44.1/48/96 kHz × 兼容/整数，共 12 组静音硬件验证通过。包含 ReplayGain、控制/时钟、结束/重播、错误命令和旧会话隔离。
- 隔离 Electron 实际 preload → 安装校验 → IPC → 文件分块 → 官方裁剪解码器 → 两种硬件后端，通过 UI 播放/暂停/跳转/切歌。
- 未验证其他声卡、外部 DAC 回录、Linux/macOS 原生输出或公开发布的 CI；不能据此声称全链路无损或全设备兼容。

## 在线原生输出恢复验证（2026-09-26）

- 类型检查通过；原生音频单测 25 项通过，Chromium 组件测试 2 项通过。
- 真实 Electron/preload/IPC → HTTP 完整下载 → 官方 FFmpeg → XingCore WASAPI 独占/ASIO：96 kHz / 24-bit 静音源，兼容与整数模式均完成播放、暂停、跳转和切换缓存 blob 测试。整数 ASIO 首次就绪等待曾超时，补充诊断并消除测试初始化脚本的重复注册后，两后端重跑通过；未据此归因于设备或产品缺陷。
- 单测覆盖保留音质 URL、缓存字节、准备前禁止播放、切歌取消下载、HTTP 错误、空响应、超限和连接中断。测试命令：`npm run test:unit -- test/unit/nativeAudio`。
- 硬件复现：Vite 4173 与原有开发组件/解码器环境变量就绪后，运行 `node test/manual/nativeAudioElectronSmoke.cjs XingCore --online`；追加 `--integer` 验证整数模式。仅输出静音。
- 本轮未重新登录在线平台做账号实播，不将 HTTP 测试等同于各平台实播验证。已有音质选择和账号解析代码未更改；读取缓存时使用缓存实际音源，不自动将旧缓存升级为更高音质。
