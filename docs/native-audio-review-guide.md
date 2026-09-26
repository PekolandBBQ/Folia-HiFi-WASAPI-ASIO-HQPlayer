# 可选原生音频：审查与源码验证

这是供维护者审查的候选实现，不是官方发布或已经获准合入的功能。普通构建仍默认使用浏览器音频。当前生产组件清单为空，不能直接安装一个旧版 Folia 来验证此功能。

## 代码入口

| 仓库/分支 | 内容 |
| --- | --- |
| [Folia：codex/native-component-stage1](https://github.com/PekolandBBQ/folia-major/tree/codex/native-component-stage1) | Electron 接入、可选安装、设置、在线准备、ReplayGain、整数模式及信号路径 |
| [组件：codex/component-stage1](https://github.com/PekolandBBQ/folia-native-audio-component/tree/codex/component-stage1) | 独立 .NET/NAudio 程序、协议 v1、构建、许可及测试 |
| [FFmpeg：codex/native-pcm-encoders](https://github.com/PekolandBBQ/folia-ffmpeg-build/tree/codex/native-pcm-encoders) | 在官方裁剪版中启用 pcm_s24le/pcm_s32le，并更新验证列表 |

Folia 分支基于主线 `d2b8467`（包含 0.7.8）。`0363b91` 是旧的本地播放提案，`45c9a27` 完成组件化，`5a1e3b7` 恢复完整准备后的在线输出。旧分支 `codex/contrib-windows-local-audio` 保留历史，不是本次验证入口。

## 1. 获取并构建组件

需要 Windows x64、Git、主项目 `.nvmrc` 指定的 Node.js，以及 .NET 8 SDK。ASIO 还需要厂商的 x64 驱动。以下命令在同一个工作目录的 PowerShell 中执行：

```powershell
git clone --branch codex/native-component-stage1 https://github.com/PekolandBBQ/folia-major.git folia-windows-contribution
git clone --branch codex/component-stage1 https://github.com/PekolandBBQ/folia-native-audio-component.git
git clone --branch codex/native-pcm-encoders https://github.com/PekolandBBQ/folia-ffmpeg-build.git folia-ffmpeg-component-build

cd folia-native-audio-component
dotnet run --project tests/Folia.Audio.Tests.csproj -c Release
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
cd ..
```

构建生成组件 ZIP、SHA-256 和 `artifacts/development-catalog.json`。开发清单含本机绝对路径，因此必须由验证者本机生成，不能复制开发者电脑上的清单。普通使用者以后通过可选组件安装，不需要 .NET SDK。

## 2. 准备包含 PCM24/PCM32 编码的解码器

现有官方固定版本未包含本提案需要的两个编码器。必须先构建上述 FFmpeg 补丁，不能用“已下载官方 FFmpeg”代替这一步。

Windows 目标沿用该构建仓库的 Linux 交叉编译方法。在 Linux/WSL Ubuntu 中进入 `folia-ffmpeg-component-build`（或在 Linux 中克隆同一分支）：

```bash
sudo apt-get update
sudo apt-get install -y build-essential mingw-w64 nasm curl xz-utils pkg-config
ARCH=x86_64 FFMPEG_VARIANT=folia ./build-windows.sh
```

产物为 `artifacts/ffmpeg-8.1.2-folia-x86_64-w64-mingw32/bin/ffmpeg.exe`。将它复制到 Windows 中的 `folia-windows-contribution/build/ffmpeg/win-x64/ffmpeg.exe`；或者在下一步用环境变量指向其实际 Windows 绝对路径。若使用 GitHub Actions，也可在自己的 FFmpeg fork 手动运行现有 Build Folia FFmpeg 工作流，获取 Windows 构建 artifact。

WSL/Linux 在这里仅用于编译解码器，不是原生音频组件运行时依赖。正式采用官方构建发布后，用户不需要自行编译或安装 WSL。

## 3. 启动 Folia 开发版

```powershell
cd folia-windows-contribution
npm ci
$env:FOLIA_NATIVE_COMPONENT_CATALOG = (Resolve-Path ../folia-native-audio-component/artifacts/development-catalog.json).Path
$env:FOLIA_NATIVE_FFMPEG_PATH = (Resolve-Path build/ffmpeg/win-x64/ffmpeg.exe).Path
& $env:FOLIA_NATIVE_FFMPEG_PATH -hide_banner -encoders | Select-String 'pcm_s24le|pcm_s32le'
npm run dev:electron
```

应看到两个编码器。进入「选项 → 播放控制 → Windows 本地音频输出」，安装组件后选择 WASAPI 独占或 ASIO 设备。整数模式及音频链路展示默认关闭，可分别打开验证。开发版复用 Folia 的应用标识和用户设置；验证前建议备份自己的设置和音乐库数据。

生产构建不接受这些开发环境变量。主进程代码更新后需要退出并重启 Electron；只刷新页面不够。

## 4. 建议检查顺序

1. 默认浏览器播放与未安装组件的情况：原有路径应可用。
2. 本地文件：播放、暂停、跳转、切歌、歌词、音量/静音；分别测试两种驱动。
3. 在线歌曲：使用已有账号和音质设置，分别测试未缓存和已缓存歌曲。必须完整准备后才播放；准备期间切歌/停止，旧曲不能抢占新曲。
4. 整数模式与 ReplayGain：沿用现有 off/track/album 设置，确认音量及静音仍有效；整数模式不等于无条件 bit-perfect。
5. 信号路径：查看真实源采样率/位深、引擎格式与合并增益；未知信息应显示未知。缓存仍可能是旧音质，不会因切换档位自动升级。
6. 设备不支持的格式、无效设备或网络失败：应明确报错，不播放部分文件。仅组件崩溃/超时按默认开启的自动回退选项切换 Web 并提示；关闭此选项时提供三种恢复操作。

## 本轮真实账号验证

见 [专项报告](native-audio-validation-report.md)。使用隔离 profile，保留原有登录 UI，不导出 token。测试脚本 `test/manual/nativeAudioProviderReview.cjs` 使用真实 Omni/Subsonic、Electron 会话下载、FFmpeg 和 XingCore；与 UI mock、进程 mock 测试分开统计。截图的「专项验证记录」为测试脚本显示的实际返回数据，不是产品新增界面。

启动隔离窗口前设置 `$env:FOLIA_REVIEW_DEBUG='1'`，随后运行 `node test/manual/nativeAudioProviderReview.cjs` 或追加 `--navidrome`。每次新建证据目录，不覆盖旧失败。仅在本机登录后运行；不要把包含账号的 profile 或完整运行时日志上传。

自动化入口：

```powershell
npm run typecheck
npm run test:unit -- test/unit/nativeAudio
# 组件 UI 测试需要 Playwright Chromium；可安装或指定本机 Chrome。
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:component -- test/component/nativeAudio.spec.ts
```

硬件静音测试：保留步骤 3 的两个环境变量，单独启动 `npx vite --host 127.0.0.1 --port 4173 --strictPort`，另一个同样配置环境变量的终端执行 `node test/manual/nativeAudioElectronSmoke.cjs XingCore --online`，将 XingCore 换成实际设备名称子串；追加 `--integer` 测试整数模式。该测试使用隔离的 Electron 用户目录、HTTP 静音源和缓存 blob，不需要流媒体账号。

验证记录及限制见 [windows-native-audio.md](windows-native-audio.md)。当前自动化硬件矩阵只覆盖 XingCore；其他设备的个人使用反馈不能替代完整矩阵。在线 HTTP 测试不能代表所有平台账号或链接均兼容。HQPlayer、Spotify/Apple Music、DSD/DoP 和跨平台原生后端不在本次范围内。
