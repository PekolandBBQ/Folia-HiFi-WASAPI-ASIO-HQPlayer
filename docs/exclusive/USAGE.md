<!-- docs/exclusive/USAGE.md -->
# Folia Exclusive HiFi 人工验证与使用说明

这是我维护的 Windows x64 预发布专版，完整名称为 **Folia Exclusive HiFi · WASAPI / ASIO / HQPlayer**。它基于 Folia v0.7.9，保留原项目的许可证和署名。

## 安装与更新

从 [本 fork 的 Release](https://github.com/PekolandBBQ/folia-major/releases/tag/v0.7.9-exclusive.1) 下载 Windows ZIP，完整解压后运行 `Folia Exclusive HiFi.exe`。不要单独移动 EXE。配置保存在 `%APPDATA%\FoliaExclusive`，不会自动导入官方版或先前人工验证版的账号、曲库和设置。

原生组件 0.1.2 和支持 PCM24/PCM32 的 FFmpeg 已随包提供；无需安装 Node 或 .NET SDK。ASIO 需要另行安装厂商的 x64 驱动。专版关闭上游自动更新；更新时退出专版，将新 ZIP 解压到新的目录。个人配置保留在上述目录。

## 三种输出方式

**浏览器播放**是默认方式，适合使用 Folia 原有频谱、音效和双甲板 automix。先用浏览器播放一首已知正常的歌曲，确认账号、曲库和音源有效。

**WASAPI / ASIO**：进入“设置 → 播放 → WASAPI及ASIO独占播放”，选择设备。组件未安装或已停用时，选择设备、整数直通等选项会提示安装，不会保存无效选择。安装后重新选择设备。组件管理操作需要先返回浏览器输出。

**HQPlayer**：进入同级的“HQPlayer 连接”独立设置项。HQPlayer 不在 WASAPI/ASIO 设备下拉列表内，也不依赖该组件。另行安装并授权 HQPlayer Desktop，在 HQPlayer 内配置 DAC、滤波器、调制器及输出模式，并启用 `Allow control from network`。本版只连接本机 `127.0.0.1:4321`。点击刷新，再点击“使用 HQPlayer 输出”；缺少 HQPlayer 时显示明确提示，依赖它的增益开关不可用。

自动发现常见安装目录和开始菜单中的 Desktop 版本（包括 6），优先使用已运行的控制接口；未运行时自动选择发现的最高版本号。找不到程序、安装在其他位置或连接失败时，点击“选择程序路径…”指定 `HQPlayerDesktop.exe` 或带版本号的 `HQPlayer*Desktop.exe`。选择会保存在专版配置目录，取消选择不会改变配置；“恢复自动检测”清除自定义关联。若当前使用 HQPlayer，成功改路径后返回浏览器暂停状态，再明确启用新的连接。

已有 HQPlayer 进程时复用；未运行时尝试后台启动。退出 Folia 时只关闭由 Folia 启动的 HQPlayer。HQPlayer 软件及许可证不随本包分发。连接失败请确认上述网络控制设置，然后重试播放；可随时从独立设置项返回浏览器播放。

## 增益与链路

HQPlayer 默认预留 −2 dB 余量，可在独立设置中调整。Folia 音量、静音及 ReplayGain 会合并计算，送往 HQPlayer 的控制增益上限为 0 dB；这不保证 HQPlayer 后续 DSP 不会产生过载。可选“记住在 HQPlayer 中调整的增益”，会扣除 Folia 音量及 ReplayGain 后保存余量。

整数直通仅用于 WASAPI/ASIO，不控制 HQPlayer 的 DSP。软件音量和 ReplayGain 仍然生效，只有合并增益为 1 时保留准备后 PCM 的采样值；不能直接将其等同于源文件到 DAC 的全链路 bit-perfect。

“显示音频链路”在 WASAPI/ASIO 与 HQPlayer 各自设置中提供。HQPlayer 的输出采样率、模式和滤波器以实际控制接口回报为准，未回报时显示“未回报”；不会用音源规格冒充输出规格。

## 建议按顺序人工验证

1. 浏览器模式播放、暂停、定位和切歌，检查歌词跟随。
2. 在 WASAPI、ASIO 各播放两首常用歌曲，切换 ReplayGain 开／关，再试整数直通和链路显示。
3. 返回浏览器并停用组件；点选 WASAPI/ASIO 设备和依赖开关，确认出现安装提示。此时 HQPlayer 已安装的话仍应可单独启用。
4. 使用 HQPlayer 播放、暂停、定位、切歌；调整 Folia 音量与增益余量，检查链路显示和实际 HQPlayer 状态。确认设备下拉列表没有 HQPlayer 项。
5. 播放 HUMMING LIFE — Spica、ピコ — 桜音，分别测试冷启动、缓存命中和暂停后重试。记录是否出现 toast、停顿或意图丢失。
6. 退出、重新打开，检查配置保存和后端选择；再从 HQPlayer 返回浏览器，确认原有功能可继续使用。

发现问题时请提供输出方式、文件格式、组件版本、错误码、复现步骤和截图。不要附带账号密码、Cookie、访问令牌或完整私人曲库。

## 当前边界

原生/HQPlayer 输出需要完整准备文件，当前没有承诺流式播放、无缝切歌或外部后端 automix。并行严格／容错处理仅用于失败恢复；本机两首故障曲目冷恢复仍约 0.66–1.00 秒，不能承诺完全无感。坏帧容错输出可播放不代表原文件已经修复。

本轮硬件验证主要为 XingCore，HQPlayer Desktop 6 使用本机既有 DSP 配置；Desktop 4/5 的发现与路径关联通过模拟文件布局测试，尚未做旧版播放硬件实测；其他 DAC、驱动和 HQPlayer 配置仍需人工验证。macOS、Linux 和普通浏览器隐藏这些 Windows 专版入口。
