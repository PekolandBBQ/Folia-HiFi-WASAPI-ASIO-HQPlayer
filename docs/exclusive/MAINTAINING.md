<!-- docs/exclusive/MAINTAINING.md -->
# 独立维护与构建

专版分支为 `codex/folia-exclusive`。上游为 `chthollyphile/folia-major`，专版发布到 `PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer`，使用独立应用标识 `io.github.pekolandbbq.folia-exclusive` 和配置目录 `Folia HiFi`。

我在更新时先核对最新稳定 Release，再评估主线差异、整合和复测。上游 A/B/C 审查分支保留最小范围；HQPlayer 与专版启动、品牌及离线分发入口属于独立 fork，不自动混入上游 PR。

## 构建输入

2026-10-14 的源码候选以最新稳定上游 `v0.7.19`（`607771d593e5b50e39defcb964928672b48310cb`）为基线；上游尚未发布的 `main` 改动不混入本轮。当前公开下载仍为 `folia-hifi-v0.7.12-r4`，不会因源码同步而替换旧标签或发行附件。候选须通过本轮单测、类型检查、音乐库/HiFi 界面、完整 Folia 实播及上游 CI 后才能合入正式分支。

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

默认同时生成 Windows x64 NSIS 安装 EXE 和免安装 ZIP；应用名称与专版版本取自 `packaging/exclusive/release.json`。应用标识保持不变，配置目录为 `Folia HiFi`；卸载默认保留配置。软件版本与所基于的上游版本一致：本轮源码候选为 0.7.19，现有公开 r4 发行件仍为 0.7.12。后续标签沿用 `folia-hifi-v<上游版本>-r<修订号>`；不覆盖旧标签或上游标签。只有通过发行验收的包才标记为正式版。

可用 `FOLIA_EXCLUSIVE_OUTPUT` 指定新输出目录。开发机器有共享依赖目录时，`FOLIA_BUILD_ROOT` 只指定依赖与公共构建资源所在项目；实际 renderer、Electron 和 shared 源码始终来自本脚本所在专版 checkout。不能将旧集成分支的构建产物当作最新专版。

Spotify 接入从本次开始采用用户指定标签 `folia-hifi-v0.7.12-r3`，后续修订沿用 `folia-` 前缀；旧 `hifi-v*` 标签保留。应用版本仍与上游保持一致。

r4 的公开路由组件采用运行时 Windows 10/11 接口选择，不再携带单一 28000 内核准入，也无需设置 `FOLIA_LOCAL_ACCEPTANCE=true` 才能正式装配。`FOLIA_WRAPPER_NATIVE_ROOT` 指向固定 route26/capture9 自包含组件对；相应源码、重建步骤和实际测试范围随 Release 提供。构建机器的内核版本不决定用户的运行资格；用户不需要 SDK 或自行构建。

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

## r5 起的双源发布

GitHub 与 Gitee 使用同一正式源码树、README、使用说明和更新说明；Gitee 只推送正式分支和 r5 起的新标签，不使用 `git push --mirror` 同步测试分支或旧版标签。保留源码提交历史与原作者署名，不把“从 r5 开始发行”理解为删除 Git 历史。

一次构建生成 EXE、ZIP 和 `folia-hifi-update.json`，两个源复用这些文件与内部构建编号，禁止各自重建后沿用同一编号。先上传安装包和便携包，再上传清单；两个源均完整后验证正式接口检查和下载。更新清单不得提前指向不存在的附件。

GitHub：`PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer`。
Gitee：`pekoland-bbq/folia-hi-fi-wasapi-asio-hqplayer`。

安装版验收包括下载完成前不能确认安装、取消确认不退出、确认后正常清理退出、安装后重新打开且配置/备份仍保留。便携版只下载 ZIP，不执行安装。每次记录真实验证结果，不把模拟请求作为线上双源已通过。
