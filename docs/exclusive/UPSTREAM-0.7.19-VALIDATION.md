# 上游 0.7.19 整合候选记录

日期：2026-10-14。当前为整合候选；自动化检查已通过，最终实播仍待完成，不能替代正式 r4 发行件。

基线：fork `646b8b5d17a1fb61e039f0c9f2ee1a62b73507d4`，上游稳定标签 `v0.7.19` / `607771d593e5b50e39defcb964928672b48310cb`。本轮不纳入尚未发布的 main。r37 原始源码、已有配置、Spicetify 备份与正式 r4 标签/附件保留。

上游主要变化是 Library v2 的资源与账户控制器、Grid / Bravais / TUI 共用音乐库、Bravais 歌手/专辑海报、结构化播放失败、icu-folia 分词、图标按需加载与 PWA 离线修复。Wrapper 连接向导适配新的账户控制器；HiFi 输出组件版本和既有路由规则保留。

合并适配修复了失败的 session 音源继续尝试空播放器、恢复任务并发去重顺序、取消任务退出时误删替代任务、输出提交失败误报 stale、暂停过程中缓存 URL 回收，以及窗口恢复错误地在暂停状态执行其他音源的路由交接。Spotify 曲目页保留重复出现的歌曲与公开元数据来源，不读写持久曲目缓存，并按账户区分资源作用域。

## 自动检查

- 第一轮全量：9391 通过、105 失败、2 跳过。原始结果保留，不能以净减少数证明产品修复。
- 第四轮最终全量：9516 通过、0 失败、2 原有跳过，包括缓存取消回收回归。旧恢复回调也按上游新契约返回 stale，不把已取消的任务作为未捕获异常抛出。
- 实播定位后第五轮：9520 通过、0 失败、2 原有跳过；新增 4 项元数据检查点回归，相关传输/输出生命周期 37 项通过。第五轮类型检查和独立目录 `dist-upstream-fix` 的 renderer/资源图通过；此构建尚未覆盖当前被恢复提示保留的运行窗口。
- 类型检查及桌面 renderer/相对资源图构建通过。
- 组件界面：470 项中 453 通过、15 失败、2 跳过；相关 23 项迁移后重跑全部通过，即该组最终覆盖 468 通过、2 原有跳过。
- 应用级界面：首轮 49 通过、2 失败；登录成功测试资料补齐状态码后，两项重跑通过；最终完整重跑 51 通过、0 失败。
- 本机 sync-server `build:node` 通过。标准依赖安装因缺少 Python / 原生编译环境未完成；本机临时使用 `npm ci --ignore-scripts`，不计为标准安装通过。远端 Linux 的标准 CI 流程已通过；sync-server 本次复用按 lockfile 键匹配的依赖缓存，并通过 `build:node`，不称为本轮重新执行了 `npm ci`。
- 远端首个候选提交 `dc8ad33ce28a2bbc9a8e999bae61a0d7a538aa70` 的根依赖安装、类型检查、全量单测、sync-server、Windows HiFi/Wrapper 界面及 Docker 验证全部通过。PR：https://github.com/PekolandBBQ/Folia-HiFi-WASAPI-ASIO-HQPlayer/pull/1 。后续记录/夹具提交的最新 CI 仍按其提交单独核对。
- 远端 Linux 全量为 9512 通过、0 失败、6 跳过；Windows HiFi/Wrapper 界面为 52 通过、0 失败。不同平台的跳过数分别记录，不与本机的 2 项跳过混用。
- 后续 `27293acb6ed1a8f71cb8cef53a119e38b74c7d20` 的单测、sync-server、Windows 界面和 Docker 均已确认通过。实播后修复提交的 CI 需重新按其提交确认。
- 诊断 IPC 原有用例已追加资料库/播放页 hash 导航场景，专项通过。附加 Node 诊断组整组 16 通过、2 因本机创建符号链接权限 `EPERM` 未完成；不计为整组通过，不修改系统设置来扩大此测试。

测试迁移保持当前需求：旧 Soloist 密钥/receiver 向导退役原文保留，改测 Wrapper 安装、配置、组件检测、重启引导与账户激活；账户诊断用例兼容 fork 的“查看诊断信息”文案，官方构建文案由上游单测另行覆盖。网易云登录资料补齐明确成功码，不放松生产中的旧会话保护。上游 Issue/PR 自动分流工作流仅在上游仓库运行，fork 不自动开启其机器人。

## 本机完整 Folia

使用独立复制的验收资料，未重装、未重跑 backup/apply、未覆盖已有备份。候选从本分支 renderer 和 Electron 源码启动。

- everscape 经 Wrapper 在完整 Folia 开始播放，接收 PCM 44.1 kHz / 32-bit 标记及歌词出现；本次尚无歌词来源和 native-terminal 交付记录，因此只计为界面播放观察，不计为自带歌词回传或最终输出新增验收通过。
- 实际暂停后正常退出，显示“保留 Spotify / 同时退出 Spotify”；本轮选择保留 Spotify。
- 随后窗口捕获连续返回 `foreground window did not report a process id`；已通知用户恢复窗口前台。音频实际交付、WASAPI/ASIO/HQPlayer、跨音源和退出路由恢复最终确认仍待完成。
- 三秒目标与偶发 Seek 保留原观察，本轮不重新判定性能。

### 2026-10-14 下午实际结果

- 曾有另一份 `C:\Program Files\Folia\Folia.exe`（0.7.7）与候选同名。当前测试对象已明确标为“Folia HiFi · 上游合并候选 0.7.19”；确认加载本候选的 `dist/index.html`，Spotify / Wrapper 账户、57 首已加载曲目及已点赞九宫格封面均出现。旧版安装与原配置保留。
- 窗口工具重绑仍失败后，重置读取会话恢复。此前捕获失败记录保留，不将它归为已证明的 Folia 播放故障。
- everscape 的 WASAPI 输出有持续非零 PCM 与播放状态；权威 `native-terminal` 为正常关闭，`capturedFrames = deliveredFrames = 3305736`，队列为 0，清理已确认。输出切换时 Spotify 路由保留；随后正常退出，原始路由回读恢复成功，`exactOriginalRolesRestored=true`，`globalDefaultsWritten=false`。
- WASAPI → HQPlayer 自动续播首次失败，未补按播放来宣称该切换通过。记录显示首次元数据恢复又发送了 Seek 0；该命令取消，而后 Play 成功。旧错误与后端恢复失败有时序关联，是否为完整原因仍待实机确认。现已避免对原生播放器已准备的同一位置再次定位；浏览器定位、不同位置的原生恢复以及输出交接所有权保留，实机修复重测尚待执行。
- 另一次正常歌单播放，HQPlayer 实际输出 `ジャイアント・キラー・チューン`，有持续非零 PCM 及外部输出位置前进；权威采集终态正常关闭，交付 `9548091` 帧，队列为 0，清理已确认。临近曲末（Folia 约 3:34）发生 `SESSION_OBSERVATION_UNTRUSTED`，随后下一首准备失败；这不是采集中断标志失败。
- 此次错误后退出恢复失败：`ROUTE_RESTORE_UNCONFIRMED`，Folia 显示恢复未确认并保持打开。原始路由 journal 在用户 Profile known folder 的 `FoliaRouteTrial`，此事务原设置为默认输出，末态保留恢复失败及 `SESSION_OBSERVATION_UNTRUSTED`。不强制退出、不删记录，不称 HQPlayer 退出恢复已通过。
- 以上 Wrapper / 采集 / 路由核心文件及 route26/capture9 与 fork 基线相同。不能仅凭此次失败把原因归到上游接口变化；具体原生观察拒绝原因需后续实机记录。下一次启动将开启现有的原生观察/恢复原因记录。
- 本轮 native 歌词日志为 `spotify-native` / 0 行；播放页已有歌词显示不足以证明本次 Spotify 自带歌词成功回传，仍按来源分别记录。
- 另观察到 WASAPI 设置定位显示在 HQPlayer 内容处，手动滚动可找到实际原生控件；先保留为设置导航待定位项。尚未计 ASIO、整数、跨音源及修复后的后端矩阵通过。

当前需先完成这轮实际环境的恢复。已请用户将 Spotify 应用输出回到原始“默认”，并退出 Spotify / HQPlayer；候选保持打开，待其回复后核查，再执行修复构建实播。没有重装、backup/apply、备份覆盖或正式分支合并。

## 合并门槛

须补齐真实输出/恢复结果以及远端 CI。候选分支可用于 CI 和审查，正式 `codex/folia-exclusive` 在全部必要项通过前不合并。本轮源码同步不自动发布新安装包，也不替换 r4 Release。
