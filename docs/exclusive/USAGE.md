<!-- docs/exclusive/USAGE.md -->
# Folia-HiFi-WASAPI-ASIO-HQPlayer 使用与人工验证说明

这是我维护的 Windows x64 正式专版，名称为 **Folia-HiFi-WASAPI-ASIO-HQPlayer**，当前版本 **0.7.12**。它基于 Folia v0.7.12，保留原项目的许可证和署名。

## 安装与更新

从 [v0.7.12 正式版](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/tag/hifi-v0.7.12) 选择一种安装方式：

| 方式 | 下载与使用 |
| --- | --- |
| **EXE 安装版（推荐）** | 下载 [Folia-HiFi-WASAPI-ASIO-HQPlayer-0.7.12-win-x64-Setup.exe](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/download/hifi-v0.7.12/Folia-HiFi-WASAPI-ASIO-HQPlayer-0.7.12-win-x64-Setup.exe)，运行安装向导并选择目录；安装后从开始菜单启动。仅为当前用户安装，提供 Windows“已安装的应用”卸载入口。 |
| **ZIP 免安装版** | 下载 [Folia-HiFi-WASAPI-ASIO-HQPlayer-0.7.12-win-x64.zip](https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/releases/download/hifi-v0.7.12/Folia-HiFi-WASAPI-ASIO-HQPlayer-0.7.12-win-x64.zip)，完整解压到可写目录，运行 `Folia-HiFi-WASAPI-ASIO-HQPlayer.exe`。不要在压缩包内直接运行，也不要单独移动 EXE。 |

两种方式包含相同程序、WASAPI/ASIO 组件 0.1.2、独立 HQPlayer 组件 0.1.2 和支持 PCM24/PCM32 的 FFmpeg，无需安装 Node 或 .NET SDK。ASIO 需要另行安装厂商的 x64 驱动，HQPlayer 需另行安装并授权。

两种方式共用 `%APPDATA%\Folia HiFi`，首次运行在新目录不存在时，将旧 `%APPDATA%\FoliaExclusive` 完整复制迁移，保留旧目录作为备份；新目录已存在则不合并、不覆盖。迁移前请退出旧版。不会自动导入官方版或旧人工验证版的账号、曲库。ZIP 免安装不等于配置随身携带，不要同时运行安装版和 ZIP 版。

更新前先退出专版。EXE 用户重新运行新版安装程序；ZIP 用户将新版完整解压到新目录。配置保留，正常卸载安装版也保留配置。专版关闭上游自动更新，请从本 fork 的 Releases 手动更新。源码 ZIP 与证据 ZIP 用于审查，不是运行包。

发行包尚未进行代码签名。Windows 可能显示未知发布者；请确认下载来源为本仓库，再用 `Get-FileHash -Algorithm SHA256 文件路径` 与 Release 的 `SHA256SUMS.txt` 比对。

## 三种输出方式

**浏览器播放**是默认方式，适合使用 Folia 原有频谱、音效和双甲板 automix。先用浏览器播放一首已知正常的歌曲，确认账号、曲库和音源有效。

**WASAPI / ASIO**：进入“设置 → 播放 → WASAPI及ASIO独占播放”，选择设备。组件未安装或已停用时，选择设备、整数直通等选项会提示安装，不会保存无效选择。安装后重新选择设备。组件管理操作需要先返回浏览器输出。

**HQPlayer**：进入同级的“HQPlayer 连接”独立设置项。HQPlayer 不在 WASAPI/ASIO 设备下拉列表内，也不依赖该组件。另行安装并授权 HQPlayer Desktop，在 HQPlayer 内配置 DAC、滤波器、调制器及输出模式，并启用 `Allow control from network`。本版只连接本机 `127.0.0.1:4321`。点击刷新，再点击“使用 HQPlayer 输出”；缺少 HQPlayer 时显示明确提示，依赖它的增益开关不可用。

自动发现常见安装目录和开始菜单中的 Desktop 版本（包括 6），优先使用已运行的控制接口；未运行时自动选择发现的最高版本号。找不到程序、安装在其他位置或连接失败时，点击“选择程序路径…”指定 `HQPlayerDesktop.exe` 或带版本号的 `HQPlayer*Desktop.exe`。选择会保存在专版配置目录，取消选择不会改变配置；“恢复自动检测”清除自定义关联。若当前使用 HQPlayer，成功改路径后返回浏览器暂停状态，再明确启用新的连接。

已有 HQPlayer 实例时先询问是否直接连接，拒绝则回到先前输出；未运行时默认完整前台启动，可开启“后台静默开启 HQPlayer”。从 HQPlayer 切换到浏览器、WASAPI 或 ASIO 时关闭全部 HQPlayer Desktop 实例并等待设备释放，包括手动打开的实例。退出 Folia 时只关闭由 Folia 启动的实例。HQPlayer 软件及许可证不随本包分发。连接失败请确认上述网络控制设置，然后重试播放；可随时从独立设置项返回浏览器播放。

切换浏览器、WASAPI、ASIO、HQPlayer 输出时保留当前歌曲与检查点；原本正在播放会自动继续，原本暂停则仍暂停。HQPlayer 的恢复受官方整秒定位和 DSP 预热影响。

## DSP 与加载提示

音频链路旁的“HQPlayer设置”提供 PCM/SDM、滤波器、整形器和目标采样率，SDM 采用 HQPlayer 的 `48k x1024` 等单位。点击“应用到当前歌曲”会重建 DSP、恢复当前检查点并自动播放，先前暂停也会续播；定位精度受官方控制接口限制为整秒。“下一首歌曲生效”保留当前歌曲设置。

浮窗另有“显示 HQPlayer 窗口”滑动开关：打开呼出 Desktop 主窗口，关闭只隐藏窗口，保留同一进程、播放与设备连接；未启动时不可用，不会凭此启动新实例。它与“后台静默开启”的下次启动偏好分开。

“设置 → HQPlayer 连接”提供相同 DSP 选项作为默认值，在每首加载前应用；浮窗当前曲或下一首设置优先。输入输出硬件设备仍在 HQPlayer Desktop 中选择，官方控制接口没有相应切换能力。

左下角紧凑进度条高 20 像素、距底部 8 像素，显示完整下载、缓存、解码及输出准备过程，避开歌曲信息浮窗。未知总量不伪造百分比。兼容模式默认关闭，严格解码失败时可选“仅当前歌曲”或“后续保持开启”。

链路与设置按钮已缩小，悬停进度条展开播放控件时向下收起，移开后恢复。详情、下拉框与加载提示使用明暗主题毛玻璃表面，弹窗展开／关闭具有过渡并遵守减少动态效果设置。HQPlayer 在连接后预读设置，重复打开立即呈现缓存完整内容，同时后台刷新；重新连接会清理会话缓存。

## 增益与链路

HQPlayer 默认预留 −2 dB 余量，可在独立设置中调整。Folia 音量、静音及 ReplayGain 会合并计算，送往 HQPlayer 的控制增益上限为 0 dB；这不保证 HQPlayer 后续 DSP 不会产生过载。可选“记住在 HQPlayer 中调整的增益”，会扣除 Folia 音量及 ReplayGain 后保存余量。

整数直通仅用于 WASAPI/ASIO，不控制 HQPlayer 的 DSP。软件音量和 ReplayGain 仍然生效，只有合并增益为 1 时保留准备后 PCM 的采样值；不能直接将其等同于源文件到 DAC 的全链路 bit-perfect。

“显示音频链路”在 WASAPI/ASIO 与 HQPlayer 各自设置中提供。HQPlayer 的输出采样率、模式和滤波器以实际控制接口回报为准，未回报时显示“未回报”；不会用音源规格冒充输出规格。升频路径注明格式，例如 `PCM 44.1 kHz → PCM 384 kHz`、`PCM 48 kHz → DSD 1024`。

## 建议按顺序人工验证

1. 浏览器模式播放、暂停、定位和切歌，检查歌词跟随。
2. 在 WASAPI、ASIO 各播放两首常用歌曲，切换 ReplayGain 开／关，再试整数直通和链路显示。
3. 返回浏览器并停用组件；点选 WASAPI/ASIO 设备和依赖开关，确认出现安装提示。此时 HQPlayer 已安装的话仍应可单独启用。
4. 使用 HQPlayer 播放、暂停、定位、切歌；调整 Folia 音量与增益余量，检查链路显示和实际 HQPlayer 状态。确认设备下拉列表没有 HQPlayer 项。
5. 播放 HUMMING LIFE — Spica、ピコ — 桜音，分别测试冷启动、缓存命中和暂停后重试。记录是否出现 toast、停顿或意图丢失。
6. 每次必测网易云音乐与 QQ 音乐：首次、重复、下一首、暂停／播放时应用 DSP、HQPlayer 到浏览器／WASAPI／ASIO 切换；分别检查前台与静默启动。
7. 退出、重新打开，检查配置保存和后端选择；应用版本随上游，独立组件版本单独核对。

发现问题时请提供输出方式、文件格式、组件版本、错误码、复现步骤和截图。不要附带账号密码、Cookie、访问令牌或完整私人曲库。

## 当前边界

原生/HQPlayer 输出需要完整准备文件，当前没有承诺流式播放、无缝切歌或外部后端 automix。并行严格／容错处理仅用于失败恢复；本机两首故障曲目冷恢复仍约 0.66–1.00 秒，不能承诺完全无感。坏帧容错输出可播放不代表原文件已经修复。

本轮硬件验证主要为 XingCore，HQPlayer Desktop 6 使用本机既有 DSP 配置；Desktop 4/5 的发现与路径关联通过模拟文件布局测试，尚未做旧版播放硬件实测；其他 DAC、驱动和 HQPlayer 配置仍需人工验证。macOS、Linux 和普通浏览器隐藏这些 Windows 专版入口。
