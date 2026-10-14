# r2 进程采集格式与恢复修复记录（2026-10-15）

本轮覆盖既有 r2；应用版本、Release 标题与页面文案保持不变。最终发布回执尚待追加，不能据此文件宣称已发布。

## 原因与修改

- Windows Spotify 进程回环使用独立的 44100 Hz、双声道 float32 采集格式，再输出 s32 PCM。旧实现仍在设备创建、绑定和会话检查中依赖 VB 端点混音格式，VB 为 48000 Hz 时可出现不必要的格式失败。现在进程路径解除这些依赖；VB 输出侧仅保留自然格式的静音路由占位，不打开 VB 采集端来强制格式。旧端点路径的格式约束仍保留。
- 原生格式读回失败记录请求格式、实际格式、差异字段与 HRESULT。界面保留中文具体原因及错误码，避免把采集绑定错误统一吞成 CAPTURE_REQUEST_FAILED。
- 采集子进程退出后，暂停清理仍要求已退出子进程返回 Stop ACK，导致 CAPTURE_STOP_TIMEOUT 阻断后续播放。现在确切子进程退出也可证明采集已停止；仅控制通道断开或发出 kill 不算确认。路由暂停清理保留原始路由记录，并允许采集子进程退出后的恢复。
- Spotify PCM 预缓冲范围为 25–5000 ms，默认 350 ms 不变，前端、主进程校验、文案与三种输出路径一致。实测发现旧输出组件仅有 3 秒队列，5 秒预缓冲永远无法完成，反压最终引起 CAPTURE_OVERFLOW；HQPlayer 与 WASAPI/ASIO 输出队列扩为 6 秒。采集实时队列仍为 2 秒。

## 组件来源

- Wrapper 统一组件包 0.1.0-preview.4 revision 4，route 0.19.0-dev.28、capture 0.1.5-capture.11。
- HQPlayer 0.1.4-preview.6 基于已发布 preview.5 的源模块和生产 bundle，仅修改队列 3→6 秒及组件版本，原有原生库不变。源码附件保留生产 bundle、模块与修改说明。
- Native audio 0.1.3-preview.3 基于已发布 preview.2 源码，修改 StreamingPcmBuffer 默认容量、StreamingPlayback 容量回报及 hello 版本；源码附件包含测试与构建脚本。
- 旧组件目录和用户配置保留，候选实测通过正常组件升级机制使用新组件。没有重装 VB、重跑 Spicetify backup、修改 Spotify 音量或人工核对校验值。

## 实测与边界

完整 Folia、真实 Spotify Wrapper、实际 HQPlayer/XingCore 输出，使用原资料；不是 mock 播放。

- 5000 ms 下 HQPlayer、ASIO、WASAPI XingCore 启播/续播及后端切换出现实际非零 PCM 和递增后端时钟。HQPlayer → ASIO、ASIO → HQPlayer、WASAPI → HQPlayer、ASIO ↔ WASAPI 已执行。
- WASAPI XingCore 连续约 93 秒，缓冲维持约 5.1 秒，未出现 buffering；ASIO 连续约 210 秒，无 buffering，自动下一首已观察。
- LG HDMI WASAPI 续播出现缓冲持续消耗并进入 buffering；相同采集与缓冲设置在 XingCore 未复现。原因尚未证实，保留该失败，不能表述为所有输出设备无异常。
- 故障注入仅结束本轮候选的确切采集子进程。修复前重试被 CAPTURE_STOP_TIMEOUT 拦截并出现无窗口退出残留；修复后同一 Folia 进程完成 paused-held、采集进程重建、HQPlayer 继续输出非零 PCM。期间没有重新配置组件。
- 修正版一次正常退出已有 exactOriginalRolesRestored=true、globalDefaultsWritten=false、quit-restoration-complete；最终实播后的退出回执待追加。
- 原远端日志没有完整格式差异字段，不将本机 48000/44100 的复现值冒充远端已证实值。SOURCE_EXPIRED 与后续会话失效分别保留，不混作单一错误。
- 不声明人工听感已确认，不重判三秒性能和偶发 Seek。原有与本轮无变化的跨源测试不重复执行，不冒充本轮新增结果。

## 针对性验证

先前本轮 11 文件 317 项单测通过，类型检查、桌面构建通过；采集格式读回 9 项、路由准备目标 15 项、进程采集 5 项、短缺口 20 项通过。随后新增错误码与确切子进程退出用例，最新 3 文件 136 项通过。HQPlayer 实际生产队列模块可在启动消费前接收 5 秒；Native audio 源码测试覆盖 5 秒入队、整数处理、暂停回退与流式背压。保留每轮测试日志，不将重复测试数量相加为独立用例数。

## 曲尾与遗留路由补充（2026-10-15）

- HQPlayer 故障恢复后连续播放到曲尾，曾在 1792014406477 停采集后由仍在途的 status 返回 SESSION_OBSERVATION_UNTRUSTED，后续 suspendPaused 被旧失败状态拦截。本次修复在 EOF 返回采集迭代器之前结束在途轮询；不抹掉播放中的真实观察失败。
- 对已经进入上述恢复状态的会话，原生层只在服务重新取得源暂停、PCM 停止证明并重新核对原进程及策略后，允许转回 held-paused。不改写原路由、不伪造活跃采集。
- 强制结束无法正常退出的旧候选后，发现孤儿恢复把 Spotify 进程存活当作旧路由仍有持有者。实际日志 1002ea6d-efeb-4837-b202-99c87c674b08 保留了两个 null 原策略。改为先取得日志的独占读写句柄（活跃持有者仍排除），存活 Spotify 需匹配原进程完整身份，再以新鲜暂停观察恢复原值；跟随默认的 null 恢复不依赖物理 DAC 可用。
- 新增针对性验证：7 文件 275 项通过；held-pause 33 项通过；Windows product composition 110 项通过。测试数为各组结果，不与前轮重复累计。上述最新修正的实播仍待完成，尚未发布。

## 最终候选实播回执

- 1792016080232：完整 Folia 自动执行 ORPHAN_ROUTE_RESTORED，原 null 策略恢复，globalDefaultsWritten=false；Spotify 没有被重装或重启来规避问题。
- HQPlayer 第一首自然结束：1792016364974 native-terminal capturedFrames=deliveredFrames=12098394、queuedBytes=0、cleanupConfirmed=true；1792016365282 held-paused；1792016369934 ended=true；随后自动播放第二首。
- 第二首使用 5000 ms 预缓冲，持续约 216 秒，正常进入 producerComplete 并在 1792016597692 ended=true，自动下一首，无曲尾 SESSION_OBSERVATION_UNTRUSTED。
- HQPlayer 切回 ASIO 后同曲自动续播，44100 Hz 双声道，持续非零 PCM。恢复测试前 ASIO 与 350 ms 设置。
- 1792016652703 最终采集终态 capturedFrames=deliveredFrames=1190700、queuedBytes=0、cleanupConfirmed=true；1792016653291 exactOriginalRolesRestored=true、globalDefaultsWritten=false；1792016653326 quit-restoration-complete，候选进程已结束。
- 最终类型检查通过；EOF 集成 31 项通过、核心路由 59 项通过。这里的实播判据是实际 PCM 交付、后端时钟及完整恢复回执，不声称自动化已听辨断续噪音。
- 上述验证覆盖本轮修复与主要 DAC 输出；前述 LG HDMI 缓冲消耗现象仍保留为未解释设备差异，未将其标为通过。
