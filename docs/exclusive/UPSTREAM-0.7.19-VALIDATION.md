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

上述失败当时等待恢复。以下记录继续说明实际恢复及重测，没有重装、backup/apply、备份覆盖或正式分支合并。

### 2026-10-14 16 时后恢复与重测

- 用户指出可由代理操作后，代理从 Spotify 的“退出”菜单正常关闭客户端；HQPlayer 与候选 Folia 当时也已结束。进程结束没有被当作原路由恢复证明，旧失败 journal 原样保留。
- `91921e42` 的单测、sync-server、Windows 界面和 Docker CI 均已确认通过；此提交的 renderer 已用于新实播，旧 renderer 分别保留，未替换 r4 发行件。
- 新一轮冷拉起先失败于 `BOOTSTRAP_IDENTITY_UNCONFIRMED` / `ORIGINAL_ENDPOINT_UNSAFE`，尚未进入输出。Windows 音量合成器随后实际显示 Spotify 输出仍为 CABLE Input，而原始 journal 记录为默认。代理只把 Spotify 应用输出恢复为“默认”，未更改系统输出或音量；随后一次正常重试进入实播。
- 修复后首次原生加载仅发送 begin / finish / play，未重复 Seek 0。WASAPI 持续非零输出；在 134.699977 秒请求 HQPlayer 后自动续播，恢复位置 134.709700 秒、playing=true，无额外手动 Play。前输出 `native-terminal` 正常关闭，captured=delivered=5968053，队列 0，清理确认。
- HQPlayer 本轮自然完成 `ジャイアント・キラー・チューン` 和 everscape，并进入第三首；两个采集终态 captured=delivered 分别为 3611349、12096189，队列均 0，清理确认。本轮未重现早前曲末观察拒绝；早前失败仍保留，不称其完整原生原因已证明。
- HQPlayer → ASIO 恰与第三首的初始准备重叠：交接捕获 position=0、playing=false，恢复后留在暂停，没有 ASIO 真实输出。本例不计作播放中自动续播通过。已定位为交接只读取尚未播放的 deck / IDLE 状态，忽略新曲目的未消耗自动播放意图。修正保留该意图，并用原生明确 Play/Pause 请求优先于自动播放；新源重置请求状态，退役保留旧请求事实。
- 新增 4 项初始准备交接回归，覆盖自动播放、无自动播放、明确暂停优先和待完成 Play；相关元数据/传输/输出生命周期 41 项通过。类型检查通过。全量第六轮 9522 通过、2 个源码扫描用例超时、2 原有跳过；扫描组单独 9 项通过，停止并行运行后第七轮完整全量为 9524 通过、0 失败、2 原有跳过。没有改断言、移除用例或放宽超时。
- 本轮最后正常退出，原生路由回读 `exactOriginalRolesRestored=true`、`globalDefaultsWritten=false`，然后“后台 Spotify”询问中选“同时退出 Spotify”；桥接断开，Folia、Spotify 主客户端和音频 helper 均结束。SpotifyLauncher 的系统启动器保留，不当作音频客户端仍运行。
- 第三首的 Wrapper 回传已记录 `spotify-native`、39 行、`LINE_SYNCED`；这与前两首 native 0 行分别保留。不能把此前页面匹配歌词一概称为 Spotify 自带歌词。

初始准备交接修正的真实 ASIO / 整数 / 输出矩阵仍待新构建完成后验证；跨音源仍待补齐。三秒与偶发 Seek 保持原观察，不做新性能通过判定。

### 2026-10-14 16:39—17:00 新构建实播与退出

- `7d13a997f8fc94d4faac8af61b189055a333944a` 包含初始准备意图修正，已加载这一提交的 renderer。该 SHA 的 PR Unit Tests、sync-server、Windows HiFi settings 与 Docker CI 均已确认通过；Cielo 自动发布按原流程跳过，没有发布新版本。
- 真实实播 run `d3952708-decf-4ae6-81e1-8f6ea7558a8e`：从已点赞歌单“播放全部”冷拉起 Spotify，ASIO 输出首曲并自然进入 everscape。首曲权威采集终态 captured=delivered=9548973、队列 0、closed、cleanupConfirmed=true。
- 播放中的 ASIO 从兼容模式切入整数模式，自动恢复位置 77.880159 → 77.885000 秒，playing=true，无手动再次 Play。音频链路实际显示“整数直通 / PCM32 integer direct”，引擎回报 s32le / 44.1 kHz / 32-bit / 2ch，持续非零 PCM；不据此宣称 Spotify 原始音源无损或全链路位完美。
- ASIO → HQPlayer 自动续播位置 218.654853 → 218.664700 秒，随后自然播完 everscape 并进入第三首。HQPlayer → ASIO 自动续播位置 125.106667 → 125.113300 秒，离开 HQPlayer 后其进程结束并释放设备。ASIO → WASAPI 整数模式自动续播位置 175.275161 → 175.282300 秒，并自然进入下一首；各后端均有非零 PCM 与实际播放位置前进。上述切换均没有补按 Play，Spotify 路由持续保留。
- 本轮 9 个权威采集终态均为 closed、cleanupConfirmed=true、capturedFrames=deliveredFrames、队列 0。正常退出的最后一段交付 4973157 帧；路由回读 exactOriginalRolesRestored=true、globalDefaultsWritten=false、observedDefaultsChanged=false。代理在“后台 Spotify”询问中选“同时退出 Spotify”，随后 Folia、Spotify 主客户端、HQPlayer 和音频 helper 均结束。
- 冷拉起前客户端关闭时的 status/library unavailable 与 Spotify 实例变化记录保留；HQPlayer 退役过程中旧 pause 请求 CANCELLED 单独保留。此轮没有出现原生观察拒绝，但此前曲末 SESSION_OBSERVATION_UNTRUSTED 与恢复失败仍保留为未解释的历史失败，不以本轮通过抹去。
- 在线平台面板明确显示网易云与 QQ 音乐未登录。当前独立候选的跨音源实播登录前提未满足，需用户登录；本地歌单待用户选择目录扫描。没有以匿名地址、页面缓存或模拟认证代替。
- 初始准备期间切换的同一时序实机回归尚未完成；本轮已验证的是冷播放、自然切歌、整数模式及播放中后端接续。此前 41 项专项与 9524 项完整单测保持通过，不冒充同一时序实测。设置命令滚动定位仍保留待定位项。

已重新打开同一正确候选供下一步账户登录和本地扫描使用，暂未开始新的音频输出。正式分支仍未合并，r4 标签与发行附件、原始配置及备份均保持原样。

## 合并门槛

### 2026-10-14 晚间补项

用户已完成 QQ/网易云登录和本地扫描（2066 首）。为允许用户继续使用电脑，测试改用仓库 Electron/Playwright 框架驱动同一完整候选的真实界面，隐藏候选窗口、不注入系统鼠标键盘。未模拟 provider、队列或设备，也未更改 Spotify 音量；操作与检查记录保存在本机 evidence。没有另建虚拟桌面或宣称 Windows 输入已隔离。

- Bravais 首页搜索原先仅调用导航，未执行搜索请求，QQ 显示空结果且无 `/user/search` 调用。修复复用现有搜索 store → Omni，先缓存结果再提交历史，在线平台取当前 provider、本地取本地目录。专项 19 项通过，界面专项 1 项通过，类型及 renderer 通过。新增 4 个单测后的完整第八轮 9528 通过、0 失败、2 原有跳过。
- 实播 `4b625320-da8c-47d6-9f2e-9606b32cd104`：真实 Omni 认证确认 Spotify/QQ/网易云均已登录。先播放 Spotify，再 QQ 搜索“晴天”，`/user/search` HTTP/code 200、30 首；点击首个实际结果播放周杰伦《晴天》，真实播放地址请求成功，原生 WASAPI 输出 44.1 kHz / 32-bit、位置持续前进、歌词出现。浏览 QQ 时保留 Spotify 路由，开始 QQ 播放后 10:59:59.092Z 才回读恢复原路由。
- 同一实播继续网易云搜索 Pekora 并播放首项（兎田ぺこら歌曲），原生 WASAPI 44.1 kHz / 32-bit、位置和歌词推进；回到 Spotify 后再从本地搜索播放《リテラチュア》，原生输出 96 kHz / 32-bit、位置前进。11:05:58.352Z 的本地换源路由回读通过。以上两个 Spotify 采集权威终态分别交付 1613619、4260942 帧，均 captured=delivered、queuedBytes=0、closed、cleanupConfirmed=true；这两个采集计数属于 Spotify，不借作 QQ/网易云/本地的采集帧证据。两次恢复均 exactOriginalRolesRestored=true、globalDefaultsWritten=false、observedDefaultsChanged=false。
- 设置命令定位实机失败已确认：先滚动到原生设置后，前方 HQPlayer 异步状态/DSP 面板增高，使目标离开视口。初始请求现在通过离散 ResizeObserver 布局变化保持目标，用户 wheel/touch/pointer/key 任一接管立即取消；不逐帧更新 React 状态。两项新浏览器回归（展开保持、用户滚动优先）通过，设置单测 134 项通过，类型/renderer 通过；完整 Folia 加载后截图确认目标区域可见。
- 实播 `3d7e7557-993d-48b3-ac38-66d6bf59e98c` 又暴露准备期间输出切换缺陷：Next 的新源尚未落地时，输出交接重开旧源并带入旧曲 70.26 秒，随后 CANCELLED 与连接不可用。失败记录保留。修复为输出设置等待当前来源解析完成或取消，再捕获 deck；队列在音源提交后释放等待，所有提前退出通过 finally 清理，不等待歌词和主题，也不强行跳进度或重建组件。来源/原生交接 44 项与队列/失败展示 158 项回归通过，类型及 renderer 通过。
- 修复后的同一时序实播 `5180c8ac-f51e-4689-b09c-e586c0a8526e`：11:24:17.342Z Next；11:24:18.944Z 选择 ASIO；新源落地后捕获 position=0、playing=true，等待元数据并自动恢复 0.0103 秒。ASIO 持续非零 PCM，没有额外 Play，也没有重开旧曲 70.26 秒。正常退出的最后采集 captured=delivered=2524284、queuedBytes=0、closed、cleanupConfirmed=true；11:25:18.061Z 原路由恢复且全局默认未写入。旧段 499653 帧终态亦正常。
- 启动时旧 Spotify 实例状态查询的 SPOTIFY_INSTANCE_CHANGED/unavailable 与刷新失败、显式 Next 退役旧请求的 CANCELLED 单独保留；本轮真实播放和新的来源/输出交接随后正常，不以此宣称日志无错误。此前 `3736eb23` 的 SESSION_OBSERVATION_UNTRUSTED/ROUTE_RESTORE_UNCONFIRMED 仍为未解释历史失败；三秒和偶发 Seek 保留观察，本轮不重新判定性能。
- 用户明确要求不重测完全重复项。搜索修复后的全量第八轮已在该指示前执行；随后设置和并发修复仅跑受影响专项与必要实播，不重跑全套播放矩阵。最新提交仍须通过既有远端 CI 后再正式合并。保留已通过项目的实现与证据版本，不能把早期全量结果写成后续源码的再次全量结果。

须补齐真实输出/恢复结果以及远端 CI。候选分支可用于 CI 和审查，正式 `codex/folia-exclusive` 在全部必要项通过前不合并。本轮源码同步不自动发布新安装包，也不替换 r4 Release。
