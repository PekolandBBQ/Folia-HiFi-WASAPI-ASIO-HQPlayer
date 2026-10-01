<!-- docs/exclusive/MAINTAINING.md -->
# 独立维护与构建

专版分支为 `codex/folia-exclusive`。上游为 `chthollyphile/folia-major`，专版发布到 `PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer`，使用独立应用标识 `io.github.pekolandbbq.folia-exclusive` 和配置目录 `Folia HiFi`。

我在更新时先核对最新稳定 Release，再评估主线差异、整合和复测。上游 A/B/C 审查分支保留最小范围；HQPlayer 与专版启动、品牌及离线分发入口属于独立 fork，不自动混入上游 PR。

## 构建输入

- `package-lock.json` 固定宿主依赖。Node 24+；安装时遵循仓库 `.npmrc` 及供应链设置。
- `packaging/exclusive/release.json` 固定版本、FFmpeg 二进制 SHA-256 和允许的组件 ZIP SHA-256。
- `FOLIA_COMPONENT_CATALOG` 指向组件构建生成的开发目录 JSON；每个条目的 `localPath` 指向其 ZIP。构建程序只接受固定哈希对应的组件。
- `FOLIA_FFMPEG_DIR` 指向含 `ffmpeg.exe` 和许可证/构建说明的目录。缺少 PCM24 或 PCM32 编码器时拒绝构建。
- Release 附件包含本次组件与 FFmpeg 构建仓库源码快照；HQPlayer 为用户自行安装的软件，不包含在构建输入中。

```powershell
npm ci
$env:ELECTRON='true'
$env:ELECTRON_DEV='false'
npx vite build
$env:FOLIA_COMPONENT_CATALOG='C:\build\components\development-catalog.json'
$env:FOLIA_FFMPEG_DIR='C:\build\ffmpeg\win-x64'
node packaging/exclusive/build.cjs
```

默认同时生成 Windows x64 NSIS 安装 EXE 和免安装 ZIP；应用名称与专版版本取自 `packaging/exclusive/release.json`。应用标识保持不变，配置目录为 `Folia HiFi`；卸载默认保留配置。软件版本始终与所基于的上游版本一致，本版为 0.7.12。专版 Git 标签使用 `hifi-v0.7.12`，同一上游版本的后续专版修订用 `hifi-v0.7.12-r2`、`-r3` 等独立标签，应用版本保持 0.7.12，避免覆盖已发布标签或上游 `v0.7.12`；GitHub Release 标记为正式版。

可用 `FOLIA_EXCLUSIVE_OUTPUT` 指定新输出目录。开发机器有共享依赖目录时，`FOLIA_BUILD_ROOT` 只指定依赖与公共构建资源所在项目；实际 renderer、Electron 和 shared 源码始终来自本脚本所在专版 checkout。不能将旧集成分支的构建产物当作最新专版。

## 发布前检查

```powershell
npm run typecheck
npm run test:unit
npx playwright test -c playwright.exclusive.config.ts test/component/nativeAudio.spec.ts --project=components --output=test-results/exclusive-ui-final
node test/manual/exclusiveReleaseSmoke.cjs
node test/manual/exclusivePlaybackReview.cjs
```

可用 `FOLIA_REVIEW_EXE` 指定已安装或解压后的程序，`FOLIA_REVIEW_OUTPUT` 指定独立证据目录。手工脚本中的真实设备匹配和两首故障样本路径为本轮复现配置；移到其他机器时应按实际环境调整，不能把找不到硬件或样本的情况算作通过。配置独立的测试用户目录，避免干扰日常播放。

发布前检查 ASAR 为当前源码、HQPlayer ZIP 与固定归档及入口哈希相同；XML 依赖已打包到独立组件中，HQPlayer 不再使用宿主中的它；主程序歌词解析仍保留自身所需的 XML 依赖。网易云与 QQ 的实际播放、输出切换和前台／静默模式均为每次必测项。保留失败与修复后证据，记录检查层级（模拟 IPC UI／实际 ASAR／真实设备），生成 SHA256SUMS 后上传资产并核对服务器回报的摘要。

上游测试要求与已完成矩阵见 [最终验证报告](../native-audio-final-validation.md)。新的完整报告只把本轮真正执行过的项目计为最新通过，其余保留基线日期与版本。

## 长期接入约束

模块归属、作者要求与每次更新的检查清单见 [架构与上游接入约束](ARCHITECTURE.md)。本分支推送和 PR 执行上游原有类型检查、全量单测和 sync-server 构建；另加相关设置 UI 回归。真实设备和安装矩阵仍须本地验证，CI 通过不能替代。
