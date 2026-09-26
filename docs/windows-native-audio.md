# Windows 原生音频第一版

贡献候选分支：`codex/contrib-windows-local-audio`。基于上游 `d2b8467`（包含稳定版 0.7.8）。这份实现用于讨论贡献方向，尚未提交正式 PR。

## 使用

安装或运行 **Folia Native Audio**，在「选项 → 播放控制 → 播放设备」下方的「Windows 本地音频输出」选择（侧栏支持直接跳转）：

- `WASAPI 独占 — 设备名称`
- `ASIO — 驱动名称`
- `浏览器音频（默认）`，用于返回原有播放方式。

命令面板也可搜索「Windows 原生音频」、WASAPI、ASIO。

从 Folia 本地音乐库选歌，继续使用原来的播放/暂停、进度条、上一首/下一首和歌词界面。设备更换后，当前曲目从头暂停；按播放继续。设备不可用时显示错误，不自动切到共享模式。按播放可重新尝试加载，或者选择其他输出。

此版本采用独立应用标识、名称和用户数据目录，可与官方 Folia 并存。需要在新版本中重新导入本地音乐目录；不会自动迁移原安装的设置。专用安装包不使用官方自动更新源。

## 范围与限制

- Windows x64；终端用户不需要安装 .NET SDK，辅助程序携带运行时。
- 本地文件通过 FFmpeg 解码为 24 位 PCM WAV，保留源采样率和声道数。WAV、FLAC、MP3 等格式由所带解码器处理。
- 第一版必须先完成当前文件解码，再开始播放；长文件首次准备会有等待。临时文件在切歌、停止或正常退出时清理。异常断电/强制结束主进程可能留下系统临时目录中的 `folia-native-audio-*` 文件夹。
- 无可用 OS 路径的浏览器文件句柄采用 1 MiB 分块传输，源文件限制为 2 GiB；解码后的 WAV 限制为 4 GiB。
- WASAPI 始终以独占模式打开设备，按原采样率协商浮点或 16/24/32 位 PCM 输出。不支持该采样率/声道组合时显示错误，不静默重采样。
- ASIO 需要已经安装的 **64 位**设备驱动，使用驱动的前几个输出通道和驱动配置的缓冲大小；第一版没有通道映射器或内嵌驱动控制面板。
- 播放/暂停、跳转、软件音量/静音、单曲循环和普通队列切歌均接入原有控制。暂停会释放输出并在恢复时重新打开。
- 原生模式绕过 EQ、ReplayGain、音效、音频频谱分析、自动混音。歌词动画保留；依赖实时频谱的效果使用现有无分析器时的显示行为。
- 在线歌曲继续使用原来的浏览器后端，不通过原生引擎播放。
- 本版不承诺 bit-perfect，不包含 DSD/DoP、无缝播放、变速播放或在线原生播放。

## 播放时钟

WASAPI 读取设备音频时钟；ASIO 使用实际音频回调消耗的帧数和驱动输出延迟估计播放位置。辅助程序约每 40 ms 报告一次状态。前端短距离插值供现有歌词/进度 `MotionValue` 使用，最多外推 120 ms，防止辅助程序故障后界面继续无限前进。

修订版将已呈现的播放时间作为下限：后台快照略落后于插值帧时，保持当前帧等待设备时钟追上，避免海报歌词把微小回退误判为跳转并反复重建。主动跳转、切歌和重播仍可重置时间，不会累积插值超前量。

暂停和跳转会清空旧缓冲并重建输出；会话标识及命令顺序用于隔离快速切歌和旧的进度事件。这里验证的是时钟与控制行为，未做外部声学测量或逐采样回录一致性认证。

## 构建

使用项目要求的 Node.js 24+、npm，以及 .NET 8 SDK（本次使用 8.0.425）。依赖锁定 NAudio 2.2.1 和 .NET 8.0.31 运行时。

```powershell
npm ci
npm run build:windows-native
```

安装包位于 `release/Folia-Native-Audio-Setup-0.7.8-x64.exe`。

普通平台构建不会编译或打包此辅助程序；仅 `build:windows-native` 的可选配置启用它，因此默认构建不增加 .NET 依赖。

单独构建辅助程序：

```powershell
npm run build:native-audio
```

若 SDK 未加入 PATH，可将 `FOLIA_DOTNET_PATH` 设置为 `dotnet.exe` 的绝对路径。首次构建会下载固定版本的 Gyan FFmpeg 8.1.2 essentials，并校验固定 SHA-256；后续构建校验已缓存的可执行文件。

`build:windows-native` 构建本次音频版本，不编译可选的 Rust 桌面壁纸辅助程序。若需要该原有功能，先准备 Rust 工具链并运行 `npm run build:wallpaper-helper`，打包时会自动带入生成的文件。

新增运行时的许可与来源记录随程序放在 `resources/native-audio/`。Folia 本身继续遵循仓库的 AGPL-3.0 许可；本分支没有打包或安装声卡厂商驱动。

## 验证

```powershell
npm run typecheck
npm run test:unit -- test/unit/nativeAudio test/unit/command-palette/commandRegistryContract.test.ts test/unit/services/playbackGraph.test.ts test/unit/automix/deckSrc.test.ts
npm run test:component -- test/component/nativeAudio.spec.ts
```

真实硬件检查只输出静音，需要明确传入设备名称的一部分：

```powershell
node test/manual/nativeAudioSmoke.cjs XingCore
```

端到端 Electron 检查：先在另一个终端启动 `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort`，然后运行：

```powershell
node test/manual/nativeAudioElectronSmoke.cjs XingCore
```

后一个测试在独立、隐藏的 Electron 窗口中运行实际 preload、IPC 服务、文件分块传输、解码器和声卡输出；用户资料位于 `test-results/native-audio-electron-profile`，不访问现有 Folia 资料。

2026-09-26 已在 XingCore USB Hi-Resolution Audio / XingCore USB Audio Device 上验证 WASAPI 独占与 ASIO 的 44.1 kHz 和 48 kHz 静音播放、时钟推进、暂停、跳转、恢复、播放结束、重新播放、旧会话拒绝和设备释放。其他声卡仍需各自验证驱动兼容性。

## 代码入口

- `native/windows-audio/`：独立驱动进程、PCM 输出和时钟。
- `electron/nativeAudio/`：进程监管、解码、会话和临时文件生命周期。
- `src/services/nativeAudio/`：本地文件加载与媒体事件适配器。
- `src/components/app/playback/PlaybackDeck.tsx`：原有媒体元素/原生媒体适配器的边界。
- `src/components/modal/settings/NativeAudioSettingsSection.tsx`：设备选择界面。
- `packaging/windows/native-audio-builder.cjs`：独立版本打包配置。

原生适配器实现 Folia 当前所用的媒体传输接口子集，并不是完整的 HTMLAudioElement。增加新的媒体 API 调用时，需同步检查该适配器；不得将其传给 Web Audio 的 `createMediaElementSource`。
