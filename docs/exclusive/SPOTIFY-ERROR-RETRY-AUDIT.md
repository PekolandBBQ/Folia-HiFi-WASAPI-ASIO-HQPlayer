# Spotify 错误与恢复审阅（本地候选，未发布）

本轮依据当前 Wrapper 进程采集实现及此前恢复修复审阅，不以旧 r4 的端点配置为标准。

## 实现与边界

- 准备入口：Wrapper 的 runtime audio 请求第一次失败后最多静默重试三次；每次重新进入完整准备，由既有 release/hold 流程清理旧会话，不直接复用失败控制器。
- 状态读取：准备、续播、Seek、暂停、路由回调及播放轮询共用内部 read。短暂读取失败先重读；播放状态短暂滞后先等待新读数，不立即撤销会话。不会直接重发任意 Play/Seek 写操作。
- 同一异步操作共享三次额度，禁止内外层叠加成十六次。独立的新请求重新计数，不让旧异常上的 exhausted 标记永久拦住恢复。
- 切歌、取消、账号变更、组件配置、退出和输出交接取消过时的准备重试。设置页状态查询不取消播放。
- 每次重试保留原错误与阶段，日志记录 retry/recovered/exhausted。三次失败只表示本次仍未恢复，不宣称已证明永久故障。
- 限流、取消、账号/进程身份变化、格式数据损坏及不具备安装条件不盲目重放。进程身份、已停采集证明、外部路由归属与原恢复记录仍保留。
- 当前重试覆盖准备和状态读取，不把已断开的 PCM 管道或已失效的 native 写事务在原会话上强行重启。此类故障仍需走完整的新源恢复；不能声称所有运行期故障已做到无感恢复。

## 旧检测审阅

| 项目 | 当前处理 |
|---|---|
| Windows 默认输出回落 VB | WindowsProductBackend 已用 !ProcessCaptureRouting.Enabled 隔离默认输出阻断；Wrapper 的 system-output 仅为 advisory。 |
| 暂停必须无活动端点会话 | 进程模式 requireNativeQuiescence=false；保留真实进程身份和 PCM 停止确认。 |
| 准备/续播必须存在非空端点会话列表 | dev.31 使用 RequiresTargetEndpointActivity=false 的进程准备证明，不恢复旧限制。 |
| 旧端点格式读回 | 保留端点分支，不作为进程采集入口的前置条件；实际 PCM 格式仍校验。 |
| 清理失败缓存 Promise | 已修为只共享进行中的清理；失败后可再次执行，不按旧错误码白名单锁死控制器。 |
| 恢复写入重试 | ownedRouteCleanup 的原生回执检查保留；不能在已经开始恢复写入且结果不明时无条件重放。 |
| OAuth scopes/音量引导 | localSourceMetadata 分支跳过官方 scopes；Wrapper 不自动调整 Spotify 音量。 |

以下是协议接收码与中文展示映射清单。保留协议码不等于保留旧分支拦截；不能通过删除接收枚举把组件具体错误吞成未知失败。

## 错误清单

| 日志代码 | 恢复策略 | 中文原因 |
|---|---|---|
| API_UNAVAILABLE | 准备/只读状态最多重试三次 | Spotify 播放控制通道暂时无法响应，本次状态读取未完成。 |
| APPLY_READBACK_MISMATCH | 保留具体原因；不直接重放写事务 | Windows 写入路由后的实际设置与请求不一致。 |
| APP_ROUTE_INTERFACE_UNAVAILABLE | 保留具体原因；不直接重放写事务 | Windows 未提供应用音频路由接口。 |
| APP_ROUTE_READ_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 无法读取 Windows 中 Spotify 的应用输出设置。 |
| APP_ROUTE_WINDOWS_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前 Windows 不支持按应用设置音频输出。 |
| APP_ROUTE_X64_REQUIRED | 保留具体原因；不直接重放写事务 | 当前路由组件需要 64 位 Windows。 |
| AUTH_REQUIRED | 保留具体原因；不直接重放写事务 | Spotify 尚未登录，或登录凭据已失效，请登录 Spotify 后继续。 |
| BASE_CABLE_ENDPOINT_REQUIRED | 保留具体原因；不直接重放写事务 | 端点采集未找到所需虚拟线缆设备。 |
| BASE_OTHER_WRITER_PRESENT | 保留具体原因；不直接重放写事务 | 端点采集检测到其他程序也在向目标线缆输出音频。 |
| BASE_PAIR_CHANGED | 保留具体原因；不直接重放写事务 | 本轮操作期间虚拟线缆设备对发生变化。 |
| BOOTSTRAP_IDENTITY_UNCONFIRMED | 保留具体原因；不直接重放写事务 | 准备路由时未能确认 Spotify 本机音频进程。 |
| CABLE_IS_DEFAULT_RENDER | 保留具体原因；不直接重放写事务 | 旧端点模式检测到 Windows 默认输出为虚拟线缆。 |
| CABLE_SHARED_WITH_OTHER_AUDIO | 保留具体原因；不直接重放写事务 | 端点模式检测到其他音频正在共享采集线缆。 |
| CANCELLED | 保留具体原因；不直接重放写事务 | 本次播放请求已取消。 |
| CAPTURE_BOOTSTRAP_TIMEOUT | 准备/只读状态最多重试三次 | 采集已开始，但未在等待时限内收到 Spotify 音频数据。 |
| CAPTURE_BUFFER_INVALID | 保留具体原因；不直接重放写事务 | Windows 返回了无效的音频缓冲区。 |
| CAPTURE_BUSY | 准备/只读状态最多重试三次 | 上一采集操作尚未结束。 |
| CAPTURE_CHANNELS_MISMATCH | 保留具体原因；不直接重放写事务 | 采集音频的实际声道数与请求不一致。 |
| CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 采集音频的声道布局不受支持。 |
| CAPTURE_CLOSED | 保留具体原因；不直接重放写事务 | 本轮采集已关闭，需要重新准备音频。 |
| CAPTURE_CONFIGURATION_REQUIRED | 保留具体原因；不直接重放写事务 | 采集所需的设备配置尚未完成。 |
| CAPTURE_CONTROL_BUSY | 准备/只读状态最多重试三次 | 音频采集程序仍在处理上一控制指令。 |
| CAPTURE_CONTROL_TIMEOUT | 准备/只读状态最多重试三次 | 音频采集程序未在规定时间内回应。 |
| CAPTURE_DEVICE_BUFFER_TOO_LARGE | 保留具体原因；不直接重放写事务 | Windows 提供的采集缓冲区超出组件支持大小。 |
| CAPTURE_DEVICE_FAILED | 保留具体原因；不直接重放写事务 | Windows 音频采集设备返回失败，设备可能已断开或被重置。 |
| CAPTURE_DISCONTINUITY | 保留具体原因；不直接重放写事务 | Windows 报告采集音频缺口超过当前容错范围。 |
| CAPTURE_FORMAT_CHANGED | 保留具体原因；不直接重放写事务 | 本轮采集期间音频格式发生变化。 |
| CAPTURE_FORMAT_INVALID | 保留具体原因；不直接重放写事务 | 采集设备返回的音频格式字段无效。 |
| CAPTURE_FORMAT_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 采集设备返回了组件不支持的音频格式。 |
| CAPTURE_FRAME_INVALID | 保留具体原因；不直接重放写事务 | 采集程序返回的音频块长度或帧边界无效，不能正确解释为音频。 |
| CAPTURE_HELPER_CLOSED | 准备/只读状态最多重试三次 | 本轮 Spotify 音频采集进程已退出，音频传输中断；可重试播放以建立新的采集会话。 |
| CAPTURE_HELPER_EXIT_UNCONFIRMED | 保留具体原因；不直接重放写事务 | 音频采集程序尚未确认退出。 |
| CAPTURE_HELPER_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 随 Folia 提供的音频采集程序无法启动。 |
| CAPTURE_INITIALIZE_TIMEOUT | 准备/只读状态最多重试三次 | 等待 Windows 初始化音频采集超时。 |
| CAPTURE_INTERVAL_EPOCH_MISMATCH | 保留具体原因；不直接重放写事务 | 收到的 Spotify 操作属于旧准备轮次，不能用于当前采集会话；已保留当前路由与清理记录。 |
| CAPTURE_INTERVAL_NOT_STOPPED | 保留具体原因；不直接重放写事务 | 上一采集轮次尚未确认停止。 |
| CAPTURE_OVERFLOW | 保留具体原因；不直接重放写事务 | 音频接收速度持续低于采集速度，缓存已满，未继续丢弃音频播放。 |
| CAPTURE_PACKET_INVALID | 保留具体原因；不直接重放写事务 | Windows 返回的音频数据包字段无效。 |
| CAPTURE_PACKET_TOO_LARGE | 保留具体原因；不直接重放写事务 | Windows 返回的单个音频数据包过大。 |
| CAPTURE_PADDING_NONZERO | 保留具体原因；不直接重放写事务 | 采集数据的填充位与声明的音频格式不一致。 |
| CAPTURE_PIPE_CLOSED | 保留具体原因；不直接重放写事务 | Spotify 音频传输通道在歌曲结束前关闭，本次音频未传输完整。 |
| CAPTURE_PIPE_FAILED | 保留具体原因；不直接重放写事务 | 采集音频传输通道发生读写错误。 |
| CAPTURE_PIPE_NOT_CONNECTED | 保留具体原因；不直接重放写事务 | 采集音频通道尚未连接。 |
| CAPTURE_PIPE_TIMEOUT | 准备/只读状态最多重试三次 | 等待采集音频通道连接超时。 |
| CAPTURE_POSITION_EPOCH_INVALID | 保留具体原因；不直接重放写事务 | 采集进度回执与当前请求轮次不一致。 |
| CAPTURE_POSITION_SOURCE_ACTIVE | 保留具体原因；不直接重放写事务 | 切换采集进度前 Spotify 尚未确认暂停。 |
| CAPTURE_PROTOCOL_INVALID | 保留具体原因；不直接重放写事务 | 采集程序返回的数据结构与 Folia 约定不一致。 |
| CAPTURE_RATE_MISMATCH | 保留具体原因；不直接重放写事务 | 采集音频的实际采样率与请求不一致。 |
| CAPTURE_READER_USED | 保留具体原因；不直接重放写事务 | 本轮音频读取器已使用，不能再次播放旧音频流。 |
| CAPTURE_READ_PENDING | 保留具体原因；不直接重放写事务 | 上一音频读取尚未结束。 |
| CAPTURE_REQUEST_FAILED | 保留具体原因；不直接重放写事务 | 采集请求失败，组件未提供更细的原因；已记录发生阶段。 |
| CAPTURE_SAMPLE_NONFINITE | 保留具体原因；不直接重放写事务 | 采集数据含有无法表示为有效声音的数值。 |
| CAPTURE_SEEK_EXPIRED | 保留具体原因；不直接重放写事务 | 采集进度切换记录已过期。 |
| CAPTURE_SEEK_IDENTITY_CHANGED | 保留具体原因；不直接重放写事务 | 拖动进度期间 Spotify 进程身份已变化。 |
| CAPTURE_SEEK_INVALID | 保留具体原因；不直接重放写事务 | 采集进度切换请求无效。 |
| CAPTURE_SEEK_NOT_PLAYING | 保留具体原因；不直接重放写事务 | 本轮采集尚未进入可切换进度的播放状态。 |
| CAPTURE_START_TIMEOUT | 准备/只读状态最多重试三次 | 等待音频采集启动超时。 |
| CAPTURE_STATE_INVALID | 保留具体原因；不直接重放写事务 | 音频采集设备与当前会话的格式或运行状态不一致，本次绑定未完成。 |
| CAPTURE_STOP_TIMEOUT | 准备/只读状态最多重试三次 | 音频采集停止指令未获得确认，当前会话尚未完成清理；已保存的连接和组件配置仍保留。 |
| CAPTURE_TIMESTAMP_ERROR | 保留具体原因；不直接重放写事务 | Windows 返回的音频时间戳不连续或无效。 |
| CAPTURE_UNSUPPORTED_PLATFORM | 保留具体原因；不直接重放写事务 | 当前系统平台不支持此采集组件。 |
| COMMUNICATIONS_POLICY_CHANGED | 保留具体原因；不直接重放写事务 | Windows 通信音频的输出设置在本轮操作中发生变化。 |
| COMPLETE_SPOTIFY_DISCOVERY_REQUIRED | 保留具体原因；不直接重放写事务 | Windows 音频会话扫描未能确认 Spotify 的音频进程，播放尚未进入采集；桥接连接状态不受此错误影响。 |
| CONTROL_REJECTED | 保留具体原因；不直接重放写事务 | Spotify 拒绝了本次播放控制请求。 |
| CONTROL_TIMEOUT | 准备/只读状态最多重试三次 | Spotify 扩展未在规定时间内回应控制指令。 |
| DEVICE_ID_MISMATCH | 保留具体原因；不直接重放写事务 | Spotify 当前播放设备与本轮采集绑定的本机设备不同。 |
| DEVICE_INACTIVE | 保留具体原因；不直接重放写事务 | Spotify 当前未把本机作为活动播放设备，或本机设备信息尚未就绪。请在 Spotify 的设备列表选择这台电脑；桥接连接成功不代表本机正在接收音频。 |
| EMPTY_PLAYER_NATIVE_PROOF_REQUIRED | 保留具体原因；不直接重放写事务 | Spotify 已无当前歌曲，但尚未取得 Windows 侧停止证明。 |
| EMPTY_PLAYER_NATIVE_QUIESCENCE_EXPIRED | 保留具体原因；不直接重放写事务 | 空播放器的音频停止记录已过期，需要重新读取。 |
| EMPTY_PLAYER_NATIVE_QUIESCENCE_UNCONFIRMED | 保留具体原因；不直接重放写事务 | Spotify 已无当前歌曲，但 Windows 侧音频停止尚未确认。 |
| EMPTY_PLAYER_RESTORE_SCOPE_INVALID | 保留具体原因；不直接重放写事务 | 空播放器的恢复请求与原会话范围不一致。 |
| ENDPOINT_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 所选音频端点当前不可用。 |
| EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH | 保留具体原因；不直接重放写事务 | 虚拟线缆输入与输出不属于同一设备对。 |
| EXACT_BASE_PAIR_REQUIRED | 保留具体原因；不直接重放写事务 | 未找到唯一对应的虚拟线缆输入与输出设备。 |
| EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN | 保留具体原因；不直接重放写事务 | Spotify 尚未建立可识别的音频会话，尚不能准备采集路由。 |
| EXTERNAL_POLICY_CONFLICT | 保留具体原因；不直接重放写事务 | 其他程序或系统设置改变了 Spotify 的输出路由，当前路由操作未继续。 |
| FOLIA_FEEDBACK_ROUTE | 保留具体原因；不直接重放写事务 | 端点模式检测到 Folia 输出可能重新进入自身采集。 |
| FORMAT_LEASE_CLOSED | 保留具体原因；不直接重放写事务 | 本轮端点格式配置已释放。 |
| FORMAT_LEASE_ENDPOINT_MISMATCH | 保留具体原因；不直接重放写事务 | 端点格式回执不属于本轮请求的设备。 |
| FORMAT_LEASE_FAILED | 保留具体原因；不直接重放写事务 | Windows 未能应用请求的端点格式。 |
| FORMAT_LEASE_IDENTITY_LIMIT | 保留具体原因；不直接重放写事务 | 端点格式配置对应的进程数量超出支持范围。 |
| FORMAT_LEASE_IDENTITY_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 无法确认持有端点格式配置的进程。 |
| FORMAT_LEASE_LOCKED | 保留具体原因；不直接重放写事务 | 另一会话仍持有端点格式配置，尚未完成释放。 |
| FORMAT_LEASE_PERIOD_INVALID | 保留具体原因；不直接重放写事务 | 设备返回的音频处理周期无效。 |
| FORMAT_LEASE_READBACK_FAILED | 保留具体原因；不直接重放写事务 | 应用端点格式后无法读取实际格式。 |
| FORMAT_LEASE_READBACK_MISMATCH | 保留具体原因；不直接重放写事务 | 采集设备应用格式后的读回结果不一致，未建立音频采集。 |
| FORMAT_LEASE_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 设备不支持所请求的端点格式配置方式。 |
| FRESH_CAPTURE_INTERVAL_BASELINE_REQUIRED | 保留具体原因；不直接重放写事务 | 新采集尚未取得本轮有效的 Windows 会话基线，未复用暂停前的旧快照；可重试重新准备。 |
| HELPER_RESTART_REQUIRED | 保留具体原因；不直接重放写事务 | 采集程序已失去响应，需要退出旧采集程序后重新启动。 |
| HQPLAYER_COMMAND_REJECTED | 准备/只读状态最多重试三次 | HQPlayer 拒绝了本次播放控制或旧会话停止指令；Spotify 桥接连接状态不受影响。 |
| HQPLAYER_CONTROL_UNAVAILABLE | 准备/只读状态最多重试三次 | HQPlayer 控制连接中断或响应超时，旧输出会话尚需完成停止确认。 |
| HQPLAYER_MULTIPLE_INSTANCES | 保留具体原因；不直接重放写事务 | 检测到多个 HQPlayer 实例，无法确定目标输出实例。 |
| INSPECTED_ORIGINALS_CHANGED | 保留具体原因；不直接重放写事务 | 检查后 Spotify 原输出设置发生变化，本轮未覆盖新设置。 |
| INVALID_AUDIO_QUALITY | 保留具体原因；不直接重放写事务 | Folia 传入了无法识别的音质偏好；应为标准、高品质、无损或 Hi-Res。Spotify 实际音质仍由其客户端决定。 |
| INVALID_AUDIO_REQUEST | 保留具体原因；不直接重放写事务 | Spotify 播放请求的歌曲编号、请求编号或音质参数未通过旧版入口校验；此错误发生在采集准备之前，与组件连接状态无关。 |
| INVALID_AUDIO_REQUEST_ID | 保留具体原因；不直接重放写事务 | Spotify 播放请求缺少有效的请求编号，尚未开始准备采集；这是 Folia 播放请求生成错误。 |
| INVALID_AUDIO_TRACK_ID | 保留具体原因；不直接重放写事务 | Spotify 播放请求缺少有效的歌曲编号，尚未开始准备采集；这是歌曲数据传递错误。 |
| INVALID_REQUEST | 保留具体原因；不直接重放写事务 | Folia 发送给采集组件的请求缺少必要字段。 |
| JOURNAL_COMMIT_FAILED_NO_MORE_POLICY_WRITES | 保留具体原因；不直接重放写事务 | 路由恢复记录保存失败，未继续修改 Windows 输出设置。 |
| JOURNAL_SECURITY_CHANGED | 保留具体原因；不直接重放写事务 | 路由恢复记录目录的访问权限发生变化。 |
| JOURNAL_STORAGE_IDENTITY_UNSAFE | 保留具体原因；不直接重放写事务 | 路由恢复记录所在目录的身份无法确认。 |
| NATIVE_PRODUCT_ADAPTER_UNQUALIFIED | 保留具体原因；不直接重放写事务 | 路由组件的 Windows 接口未通过能力确认。 |
| NON_BASE_DEFAULT_OUTPUT_REQUIRED | 保留具体原因；不直接重放写事务 | Spotify 原输出没有可用的实际播放设备；Windows 默认输出不能是 VB-CABLE。 |
| NO_POLICY_WRITES | 保留具体原因；不直接重放写事务 | 此组件运行模式不允许修改应用音频路由。 |
| ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN | 保留具体原因；不直接重放写事务 | 端点采集尚未确认 Spotify 原来的实际输出会话。 |
| ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS | 保留具体原因；不直接重放写事务 | Spotify 原输出设备已断开或无法唯一识别，无法保存退出后的恢复目标。 |
| ORIGINAL_ENDPOINT_UNSAFE | 保留具体原因；不直接重放写事务 | Spotify 的应用输出仍指向 VB-CABLE 或不可用设备，无法作为退出后的恢复目标；这与 Windows 默认输出是不同设置。 |
| ORIGINAL_EXPLICIT_ENDPOINT_CHANGED | 保留具体原因；不直接重放写事务 | Spotify 原输出设备在准备期间发生变化，路由尚未提交。 |
| ORIGINAL_PHYSICAL_OWNER_UNPROVEN | 保留具体原因；不直接重放写事务 | 无法确认 Spotify 原输出对应的实际设备，路由尚未修改。 |
| ORIGINAL_POLICY_ENDPOINT_UNRESOLVED | 保留具体原因；不直接重放写事务 | 无法把 Spotify 原输出设置对应到实际设备。 |
| ORIGINAL_POLICY_PROOF_REQUIRED | 保留具体原因；不直接重放写事务 | 尚未读取并保存 Spotify 原输出设置，不能开始路由变更。 |
| ORIGINAL_POLICY_UNSAFE | 保留具体原因；不直接重放写事务 | 原应用输出设置无法用于本次路由恢复。 |
| ORIGINAL_POLICY_VALUES_INVALID | 保留具体原因；不直接重放写事务 | 读取到的 Spotify 原输出设置字段无效。 |
| ORPHAN_ROUTE_RECORD_NOT_FOUND | 保留具体原因；不直接重放写事务 | Spotify 应用输出不可用，且没有找到可恢复的旧 Folia 路由记录。请在 Windows 音量混合器中把 Spotify 的输出改为“默认”。 |
| ORPHAN_ROUTE_RECOVERY_FAILED | 保留具体原因；不直接重放写事务 | 恢复上一轮 Folia 路由未完成，原路由记录已保留。 |
| ORPHAN_ROUTE_SOURCE_NOT_PAUSED | 保留具体原因；不直接重放写事务 | 旧 Folia 路由恢复尚未执行：Windows 未能确认原 Spotify 会话已静止（仍有活动会话或扫描证据不足）；这不表示组件未连接。 |
| OWNED_SILENT_RENDER_LEASE_ALREADY_BOUND | 保留具体原因；不直接重放写事务 | 静音占位会话已绑定另一轮采集。 |
| OWNED_SILENT_RENDER_LEASE_INVALID | 保留具体原因；不直接重放写事务 | 端点采集的静音占位记录无效。 |
| OWNED_SILENT_RENDER_LEASE_LOST | 保留具体原因；不直接重放写事务 | 端点采集的静音占位会话已丢失。 |
| OWNED_SILENT_RENDER_LEASE_NOT_STOPPED | 保留具体原因；不直接重放写事务 | 端点采集的静音占位会话仍显示活动，暂停清理未完成；这与 Spotify 是否连接无关。 |
| OWNED_SILENT_RENDER_LEASE_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 组件不支持当前请求的静音占位方式。 |
| PAUSED_PROOF_TRANSFER_EXPIRED | 保留具体原因；不直接重放写事务 | 暂停状态交接记录已过期。 |
| PAUSED_PROOF_TRANSFER_INVALID | 保留具体原因；不直接重放写事务 | 暂停状态交接记录无效。 |
| PAUSED_PROOF_TRANSFER_SUPERSEDED | 保留具体原因；不直接重放写事务 | 暂停状态交接已被新的操作替代。 |
| PAUSED_PROOF_TRANSFER_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前组件不支持暂停状态交接。 |
| PAUSED_ROUTE_STATE_INVALID | 保留具体原因；不直接重放写事务 | 暂停保留的路由状态与当前操作不一致。 |
| PAUSED_ROUTE_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前组件不支持暂停时保留路由。 |
| PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED | 准备/只读状态最多重试三次 | Spotify 已回报暂停，但旧路由组件未确认 Windows 音频会话静止；本次清理尚未完成。重试会重新核对并恢复会话，无需重新安装或配置。 |
| PAUSED_SOURCE_OBSERVATION_INVALID | 保留具体原因；不直接重放写事务 | Spotify 暂停确认的 Windows 会话扫描不完整、时间已过期或进程不一致；本次未使用这份扫描结果。重试将重新采集状态。 |
| PAUSED_SOURCE_OBSERVATION_IN_FUTURE | 保留具体原因；不直接重放写事务 | Windows 音频会话快照时间晚于当前时间，本次时间校验未通过；重试会重新读取。 |
| PAUSED_SOURCE_OBSERVATION_STALE | 准备/只读状态最多重试三次 | Windows 返回的音频会话快照早于本次请求，未使用过期快照；重试会重新读取。 |
| PAUSED_SOURCE_OBSERVATION_TIMEOUT | 准备/只读状态最多重试三次 | Windows 音频会话暂停确认在 2 秒内未完成；重试将重新核对当前状态。 |
| PAUSED_SOURCE_PROCESS_MISMATCH | 保留具体原因；不直接重放写事务 | Windows 会话扫描中的进程与当前 Spotify 进程不一致，未将其他进程的状态作为本轮采集依据。 |
| PAUSED_SOURCE_SCAN_INCOMPLETE | 准备/只读状态最多重试三次 | Windows 未返回完整的 Spotify 音频会话扫描，本轮采集基线未建立；重试会重新扫描。 |
| PAUSED_SOURCE_SESSIONS_STILL_ACTIVE | 准备/只读状态最多重试三次 | Spotify 已回报暂停，但 Windows 仍将其音频会话标为活动；端点采集的暂停确认未完成。重试将重新检查会话状态。 |
| PAUSED_SOURCE_SESSION_ID_MISSING | 保留具体原因；不直接重放写事务 | Windows 返回的 Spotify 音频会话缺少实例标识，本轮无法建立明确的采集基线。 |
| PCM_STOP_NOT_CONFIRMED | 准备/只读状态最多重试三次 | 旧 Spotify 采集尚未确认停止，新的采集未启动；原路由记录保留。 |
| PLAYBACK_STATE_UNCONFIRMED | 准备/只读状态最多重试三次 | Spotify 回传的播放状态与本次操作要求不一致，尚未确认暂停、进度或准备状态；日志保留具体操作阶段。旧会话会先重新清理，不会要求重装组件。 |
| POLICY_CHANGED_BEFORE_APPLY | 保留具体原因；不直接重放写事务 | 应用路由前 Windows 输出设置已变化，本轮未覆盖新设置。 |
| PREPARATION_OBSERVATION_CHANGED_DURING_SCAN | 保留具体原因；不直接重放写事务 | 扫描过程中 Spotify 播放状态发生变化。 |
| PREPARATION_OBSERVATION_FORBIDDEN | 保留具体原因；不直接重放写事务 | 当前会话阶段不允许提交这份准备状态。 |
| PREPARATION_OBSERVATION_INVALID | 保留具体原因；不直接重放写事务 | 采集准备的状态记录不完整。 |
| PREPARATION_OBSERVATION_REPLAYED | 保留具体原因；不直接重放写事务 | 采集准备使用了已失效的旧状态记录。 |
| PREPARED_RETAIN_ACK_INVALID | 保留具体原因；不直接重放写事务 | 保留路由的回执无效，未沿用旧回执。 |
| PREPARED_SELECTION_INVALID_STATE | 准备/只读状态最多重试三次 | Spotify 准备步骤与当前会话状态不一致，新的采集尚未启动；需要结束未完成的准备后重新建立会话。 |
| PREPARED_SELECTION_IN_PROGRESS | 保留具体原因；不直接重放写事务 | 上一歌曲选择操作尚未结束。 |
| PREPARED_SELECTION_PROOF_REQUIRED | 保留具体原因；不直接重放写事务 | 尚未确认 Spotify 已选中请求的歌曲。 |
| PREPARED_SELECTION_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前组件不支持请求的歌曲准备方式。 |
| PREPARED_TARGET_ACTIVITY_EXPIRED | 准备/只读状态最多重试三次 | Spotify 已收到播放指令，但 Windows 音频路由观察未在准备时限内完成；这不是组件未安装或账号未连接。 |
| PREPARED_TARGET_ACTIVITY_INVALID_STATE | 保留具体原因；不直接重放写事务 | 准备确认与当前采集阶段不一致。 |
| PREPARED_TARGET_ACTIVITY_REQUIRED | 准备/只读状态最多重试三次 | Spotify 本次播放准备记录缺失，或与当前进程、歌曲、采集模式及准备轮次不一致；尚未启动新的采集。重试将重新建立准备状态，无需重装组件。 |
| PREPARED_TARGET_ACTIVITY_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前组件不支持请求的采集准备确认方式。 |
| PROCESS_CAPTURE_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前 Windows 不支持 Spotify 进程专属采集，需要系统内部版本 20348 及以上；无需重装组件。 |
| PROCESS_LIMIT | 保留具体原因；不直接重放写事务 | Spotify 音频进程数量超出组件支持范围。 |
| PRODUCT_CONTROL_AUTHORITY_LOST | 保留具体原因；不直接重放写事务 | 本轮 Folia 已失去路由控制权。 |
| PRODUCT_DISCOVERY_UNQUALIFIED | 保留具体原因；不直接重放写事务 | 路由组件尚未确认音频进程发现能力。 |
| PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED | 保留具体原因；不直接重放写事务 | 路由恢复记录目录创建后无法继续访问。 |
| PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE | 保留具体原因；不直接重放写事务 | 保存原路由记录的目录当前无法访问。 |
| PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED | 保留具体原因；不直接重放写事务 | 路由恢复记录需要保存在可用的本地固定磁盘。 |
| PRODUCT_JOURNAL_PARENT_OPEN_FAILED | 保留具体原因；不直接重放写事务 | 无法打开路由恢复记录的父目录。 |
| PRODUCT_JOURNAL_PARENT_REQUIRED | 保留具体原因；不直接重放写事务 | 缺少路由恢复记录的父目录。 |
| PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED | 保留具体原因；不直接重放写事务 | 路由恢复记录所在磁盘已变化。 |
| PRODUCT_JOURNAL_ROOT_CREATE_FAILED | 保留具体原因；不直接重放写事务 | 无法创建路由恢复记录目录。 |
| PRODUCT_OPERATION_FAILED | 保留具体原因；不直接重放写事务 | Windows 路由操作失败，组件未提供更细的原因；已保留诊断日志。 |
| PRODUCT_PARENT_APPLY_AUTHORITY_LOST | 保留具体原因；不直接重放写事务 | 路由组件与发起操作的 Folia 进程已失去关联。 |
| PRODUCT_PREPARED_ACK_MISMATCH | 保留具体原因；不直接重放写事务 | 路由准备回执与当前请求不一致。 |
| PROTOCOL_INCOMPATIBLE | 保留具体原因；不直接重放写事务 | 采集组件协议与当前 Folia 不兼容，需要更新配套组件。 |
| PROTOCOL_INVALID | 保留具体原因；不直接重放写事务 | Spotify 控制通道返回的数据缺少必要字段或格式不正确。 |
| RATE_LIMITED | 保留具体原因；不直接重放写事务 | Spotify 暂时限制了请求频率，请等待限制解除；不会重复请求加重限流。 |
| RECOVERY_ORIGINAL_BINDING_REQUIRED | 保留具体原因；不直接重放写事务 | 恢复记录缺少原输出与 Spotify 进程的对应关系。 |
| RECOVERY_PLAYBACK_OWNERSHIP_UNCONFIRMED | 保留具体原因；不直接重放写事务 | 无法确认待恢复的播放仍属于本轮 Folia 会话。 |
| RENDER_CHANNELS_MISMATCH | 保留具体原因；不直接重放写事务 | 端点模式的线缆输出声道数与请求不一致。 |
| RENDER_RATE_MISMATCH | 保留具体原因；不直接重放写事务 | 端点模式的线缆输出采样率与请求不一致。 |
| RESTORE_OBSERVATION_CHANGED | 保留具体原因；不直接重放写事务 | 恢复路由期间 Spotify 状态发生变化。 |
| RESTORE_OBSERVATION_INVALID | 保留具体原因；不直接重放写事务 | 恢复路由所需的状态记录不完整。 |
| RESTORE_OBSERVATION_REPLAYED | 保留具体原因；不直接重放写事务 | 恢复请求携带了已经使用过的状态记录。 |
| RESTORE_READBACK_MISMATCH | 保留具体原因；不直接重放写事务 | Windows 恢复路由后的实际设置与原记录不一致。 |
| ROUTE_BUSY | 准备/只读状态最多重试三次 | 上一音频路由操作尚未完成。 |
| ROUTE_COMPONENT_INVALID | 保留具体原因；不直接重放写事务 | 音频路由组件文件缺失或无法加载。 |
| ROUTE_CONTROL_TIMEOUT | 准备/只读状态最多重试三次 | 路由组件未在规定时间内回应。 |
| ROUTE_HELPER_ABNORMAL_EXIT | 保留具体原因；不直接重放写事务 | 路由组件意外退出，旧会话不能继续使用。 |
| ROUTE_HELPER_CLOSED | 准备/只读状态最多重试三次 | 本轮音频路由进程已经退出，无法继续使用旧会话；已保存的组件配置与原路由备份仍保留。 |
| ROUTE_HELPER_EXIT_UNCONFIRMED | 保留具体原因；不直接重放写事务 | 路由组件退出尚未确认，原恢复记录保留。 |
| ROUTE_HELPER_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 随 Folia 提供的音频路由程序无法启动。 |
| ROUTE_HELPER_UNQUALIFIED | 保留具体原因；不直接重放写事务 | 路由组件未通过启动能力确认。 |
| ROUTE_IDENTITY_UNAVAILABLE | 保留具体原因；不直接重放写事务 | 无法确认采集路由对应的进程身份。 |
| ROUTE_LEASE_LOST | 保留具体原因；不直接重放写事务 | 当前采集持有的路由会话已失效。 |
| ROUTE_OBSERVATION_FAILED | 准备/只读状态最多重试三次 | Windows 音频路由状态读取失败。 |
| ROUTE_OBSERVER_STOP_UNCONFIRMED | 保留具体原因；不直接重放写事务 | Windows 路由观察任务尚未确认停止。 |
| ROUTE_PROOF_UNCONFIRMED | 保留具体原因；不直接重放写事务 | 尚未取得当前采集所需的路由准备记录。 |
| ROUTE_PROTOCOL_INVALID | 保留具体原因；不直接重放写事务 | 路由组件回传的数据格式与 Folia 不一致。 |
| ROUTE_RESTORE_UNCONFIRMED | 保留具体原因；不直接重放写事务 | Spotify 原输出路由尚未确认恢复；已保留原路由记录以供继续恢复。 |
| ROUTE_SESSION_LIMIT | 保留具体原因；不直接重放写事务 | 音频会话数量超出路由组件支持范围。 |
| ROUTE_SOURCE_DEFAULT_REQUIRED | 保留具体原因；不直接重放写事务 | 旧端点模式要求 Spotify 应用输出使用默认设备。 |
| ROUTE_SOURCE_PAUSE_UNCONFIRMED | 准备/只读状态最多重试三次 | Spotify 暂停指令或随后状态回读未能确认暂停，当前会话仅保留清理权限；新的播放会先重新确认暂停与采集停止。 |
| ROUTE_TRIAL_OPT_IN_REQUIRED | 保留具体原因；不直接重放写事务 | 载入了仍要求实验授权的旧路由组件，请更新配套组件。 |
| ROUTE_TRIAL_PLATFORM_MISMATCH | 保留具体原因；不直接重放写事务 | 路由组件与当前系统平台不兼容。 |
| SCOPES_UNKNOWN | 保留具体原因；不直接重放写事务 | 尚未取得 Spotify 账号授权范围，无法确认此操作的权限。 |
| SCOPE_REQUIRED | 保留具体原因；不直接重放写事务 | Spotify 账号尚未授予此操作所需的权限。 |
| SEEK_PARK_EVIDENCE_REQUIRED | 保留具体原因；不直接重放写事务 | 拖动进度前尚未确认旧采集停止。 |
| SEEK_PARK_EXPIRED | 保留具体原因；不直接重放写事务 | 拖动进度时保留的采集资源已超过有效期，需要停止旧采集后重新准备；不会复用过期音频。 |
| SEEK_PARK_KEEPER_CHANGED | 保留具体原因；不直接重放写事务 | 拖动进度期间，保留的采集占位会话已变化，无法沿用旧资源；需要重新建立采集。 |
| SEEK_PARK_RECEIPT_INVALID | 保留具体原因；不直接重放写事务 | 拖动进度时的采集停止回执无效。 |
| SEEK_PARK_STATE_INVALID | 保留具体原因；不直接重放写事务 | 拖动进度时的采集保留状态不一致。 |
| SEEK_PARK_TOKEN_INVALID | 保留具体原因；不直接重放写事务 | 拖动进度请求不属于当前保留的采集会话。 |
| SEEK_PARK_UNSUPPORTED | 保留具体原因；不直接重放写事务 | 当前组件不支持拖动进度时保留采集资源。 |
| SEEK_UNCONFIRMED | 准备/只读状态最多重试三次 | Spotify 未确认已到达请求的播放进度，当前拖动进度操作未完成。 |
| SESSION_OBSERVATION_UNTRUSTED | 准备/只读状态最多重试三次 | Windows 音频会话观察未能确认本轮 Spotify 路由或静音占位会话，当前采集未启动；这不表示桥接未连接。 |
| SOURCE_BROKER_FAILED | 准备/只读状态最多重试三次 | Spotify 控制通道未能完成暂停状态读取，旧会话尚未清理；可重试重新核对。 |
| SOURCE_BROKER_UNAVAILABLE | 准备/只读状态最多重试三次 | Spotify 暂停状态读取通道暂时不可用，旧会话尚未清理；可重试重新连接控制通道。 |
| SOURCE_DEFAULT_POLICY_REQUIRED | 保留具体原因；不直接重放写事务 | 旧端点模式尚未确认 Spotify 使用默认输出设置。 |
| SOURCE_EFFECT_UNKNOWN | 准备/只读状态最多重试三次 | 上一次 Spotify 控制指令未收到结果，尚不能确定播放状态。 |
| SOURCE_EPOCH_MISMATCH | 保留具体原因；不直接重放写事务 | 操作属于旧播放轮次，不能用于当前歌曲。 |
| SOURCE_NOT_PAUSED | 准备/只读状态最多重试三次 | Spotify 当前仍在播放，暂停指令尚未获得本机状态确认；当前采集已停止，可重试恢复。 |
| SOURCE_OBSERVATION_STALE | 准备/只读状态最多重试三次 | Spotify 返回的播放状态早于本次操作，未采用这份旧状态。 |
| SOURCE_PAUSE_CONFIRMATION_REQUIRED | 保留具体原因；不直接重放写事务 | 路由变更前尚未取得 Spotify 暂停确认。 |
| SOURCE_PAUSE_DEVICE_MISMATCH | 保留具体原因；不直接重放写事务 | 暂停确认来自另一播放设备，不能作为本机停止证明。 |
| SOURCE_PAUSE_NOT_CONFIRMED | 保留具体原因；不直接重放写事务 | Spotify 暂停请求尚未获得状态确认。 |
| SOURCE_RESUMED_DURING_PAUSE_PROOF | 准备/只读状态最多重试三次 | 确认暂停期间 Spotify 又恢复了播放，本次状态已变化；可重试重新准备当前歌曲。 |
| SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH | 准备/只读状态最多重试三次 | Spotify 返回的播放设备或状态时间与本次请求不一致，本次未采用旧状态；可重试重新读取。 |
| SOURCE_STATUS_REQUIRED | 保留具体原因；不直接重放写事务 | 路由操作缺少本轮 Spotify 播放状态。 |
| SOURCE_TRACK_CHANGED | 保留具体原因；不直接重放写事务 | Spotify 当前歌曲已改变，本次操作仍属于上一首歌曲；需要按当前歌曲重新准备，不能继续旧采集。 |
| SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET | 保留具体原因；不直接重放写事务 | 端点采集发现 Spotify 音频会话未进入指定输出。 |
| SPOTIFY_AUDIO_PROCESS_AMBIGUOUS | 保留具体原因；不直接重放写事务 | 检测到多个可能的 Spotify 音频进程，无法确定本轮采集目标。 |
| SPOTIFY_BACKUP_MISSING | 保留具体原因；不直接重放写事务 | 原资源目录没有可复用的 Spicetify 备份，无法无损升级；原目录已保留。 |
| SPOTIFY_BRIDGE_NOT_READY | 保留具体原因；不直接重放写事务 | Spotify 已运行，但 Folia 桥接扩展在 30 秒内没有连接。请完成一键配置后重启 Spotify。 |
| SPOTIFY_CABLE_SELECTION_REQUIRED | 保留具体原因；不直接重放写事务 | 没有识别到唯一的 VB-CABLE 输入输出设备对，无法确定采集设备。 |
| SPOTIFY_CANDIDATE_SET_CHANGED | 保留具体原因；不直接重放写事务 | 扫描期间 Spotify 进程集合发生变化，需要重新建立目标身份。 |
| SPOTIFY_COMPONENT_RECEIPT_UNREADABLE | 保留具体原因；不直接重放写事务 | 组件配置记录无法读取，原配置和备份已保留。 |
| SPOTIFY_COMPONENT_SETUP_REQUIRED | 保留具体原因；不直接重放写事务 | 所选 Spotify 的 Folia 资源目录缺失，请完成一键配置。 |
| SPOTIFY_CONFIGURATION_VERSION_CHANGED | 保留具体原因；不直接重放写事务 | 当前资源配置属于另一套 Spotify 安装，请为所选安装完成一键配置。 |
| SPOTIFY_DISCOVERY_TIMEOUT | 保留具体原因；不直接重放写事务 | 等待 Windows 返回 Spotify 音频进程信息超时。 |
| SPOTIFY_EXTENSION_UPDATE_REQUIRED | 保留具体原因；不直接重放写事务 | 已检测到旧版 Folia 桥接扩展，一键配置将更新它；原备份保持不变。 |
| SPOTIFY_INSTANCE_CHANGED | 保留具体原因；不直接重放写事务 | 本次采集绑定的 Spotify 进程已退出或被新进程替换，旧会话不能继续使用；需要重新建立采集会话，这不等同于账号断开。 |
| SPOTIFY_OTHER_INSTALL_RUNNING | 保留具体原因；不直接重放写事务 | 运行中的 Spotify 与选定的桌面版或 Store 版不一致。请退出另一版本，或选择正在使用的版本。 |
| SPOTIFY_PLAYER_NOT_READY | 保留具体原因；不直接重放写事务 | 桥接已连接，但 Spotify 尚未提供本机账号和播放设备。请在 Spotify 中完成登录。 |
| SPOTIFY_PROCESS_AMBIGUOUS | 保留具体原因；不直接重放写事务 | 检测到多个 Spotify 采集目标，无法确定当前进程。 |
| SPOTIFY_PROCESS_CHANGED | 保留具体原因；不直接重放写事务 | Spotify 进程已更换，需要为新进程重新建立采集。 |
| SPOTIFY_ROUTE_NOT_FOUND | 保留具体原因；不直接重放写事务 | 未找到当前 Spotify 音频进程的输出路由。 |
| SPOTIFY_SETUP_STOP_FAILED | 保留具体原因；不直接重放写事务 | 配置前无法退出所选 Spotify，组件文件尚未修改。 |
| SPOTIFY_SETUP_STOP_TIMEOUT | 保留具体原因；不直接重放写事务 | 已请求退出所选 Spotify，但进程或桥接连接未在 10 秒内结束，组件文件尚未修改。 |
| SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC | 保留具体原因；不直接重放写事务 | Wrapper 使用自动配置，请使用一键配置；旧手动保存操作不适用。 |
| STALE_GENERATION | 保留具体原因；不直接重放写事务 | 操作属于已结束的采集轮次。 |
| SUPERVISOR_CANCELLED | 保留具体原因；不直接重放写事务 | 路由操作已随所属播放请求取消。 |
| TRACK_NOT_CURRENT | 保留具体原因；不直接重放写事务 | Spotify 桌面当前歌曲与 Folia 请求的歌曲不同，请选择是否追随桌面播放。 |
| TRACK_UNAVAILABLE | 保留具体原因；不直接重放写事务 | Spotify 当前无法播放这首歌曲，可能因歌曲下架或账号所在地区不支持。 |
| WINDOWS_PRODUCT_JOURNAL_REQUIRED | 保留具体原因；不直接重放写事务 | 本轮路由缺少可用的恢复记录。 |

## 验证记录

- 274 项 Vitest 相关回归通过（7 文件），另新增 1 项真实准备/清理调用链的模拟故障回归通过（合计 275 项独立用例），涵盖 Wrapper、准备、连续清理失败、切歌、输出替换、暂停及 Seek。
- 22 项 Node 专项测试通过，包括三次额度、嵌套不倍增、后续请求重置预算、取消/切歌/退出/输出交接中止旧重试、全部路由/采集码中文映射。
- TypeScript 类型检查通过。
- 本轮中间失败保留于 r2-retry-control-all.log：取消把 STALE_SESSION 改写为 CANCELLED；修正为先核对会话身份后，原测试与新增测试通过。
- 以上为自动化/模拟故障验证，未冒充真实设备出声测试。本地候选供用户实播；没有发布，没有覆盖配置或原备份。
- 候选：artifacts/Folia-HiFi-0.7.19-r2-silent-retry-20261015/win-unpacked/Folia-HiFi-WASAPI-ASIO-HQPlayer.exe。
- 证据目录：spotify-r37-local/evidence；r2-retry-final.log、r2-retry-node-final.log、r2-retry-typecheck.log、r2-silent-retry-assembly.log。

新增集成用例实际调用 audio.prepare → release → native hold：前三次 hold 失败，第四次成功后才发布替换 PCM，随后停止并恢复路由。属于原生接口模拟，不代表实机出声。证据 r2-retry-real-cleanup.log（38 项为同文件总数，不重复累计）。
