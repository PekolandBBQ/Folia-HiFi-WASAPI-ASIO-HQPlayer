'use strict';
// Preserve bounded machine codes across IPC; messages explain the failed operation without exposing account data.
const descriptions = {
 SEARCH_API_UNAVAILABLE: '当前 Spotify 客户端尚未提供在线搜索接口，请重启 Spotify 以加载新版桥接；不会退回已点赞歌曲冒充在线结果。',
 BRIDGE_UPDATE_REQUIRED: 'Spotify 仍在运行旧版桥接，尚不支持在线搜索或收藏。请保持 Folia 打开，完全退出 Spotify 后回到 Folia 重试，由 Folia 自动拉起；无需重装组件或重新配置。',
 SPOTIFY_RESOURCE_DIRECTORY_MISSING: 'Spotify 启动时未使用当前 Folia 的桥接资源目录。请退出 Spotify 后回到 Folia 重试，由 Folia 自动拉起；无需重装或重新配置。',
 SEARCH_REQUEST_FAILED: 'Spotify 在线搜索请求失败，请稍后重试；当前播放不受影响。',
 SEARCH_SCHEMA_INVALID: 'Spotify 在线搜索返回的数据格式与当前桥接不匹配，未显示本地缓存结果。',
 SEARCH_RATE_LIMITED: 'Spotify 暂时限制了搜索请求，本次未继续重试；当前播放不受影响。',
 LIBRARY_WRITE_UNAVAILABLE: 'Spotify 收藏接口尚未就绪，请重启 Spotify 以加载新版桥接。',
 LIBRARY_WRITE_FAILED: 'Spotify 未完成收藏操作，本地收藏状态未标记成功。',
 LIBRARY_WRITE_UNCONFIRMED: 'Spotify 收藏请求已发送，但回读仍未确认目标状态，请刷新已点赞歌单确认。',
 LIBRARY_RATE_LIMITED: 'Spotify 暂时限制了歌单请求，本次未继续重试；当前播放不受影响。',
 LIBRARY_SCHEMA_INVALID: 'Spotify 返回的收藏状态格式无法识别，本地未标记成功。',
 ...require('./routeFailureDescriptions.cjs'),
 ...require('./captureFailureDescriptions.cjs'),
 AUTH_REQUIRED: 'Spotify 尚未登录，或登录凭据已失效，请登录 Spotify 后继续。',
 SCOPE_REQUIRED: 'Spotify 账号尚未授予此操作所需的权限。',
 SCOPES_UNKNOWN: '尚未取得 Spotify 账号授权范围，无法确认此操作的权限。',
 RATE_LIMITED: 'Spotify 暂时限制了请求频率，请等待限制解除；不会重复请求加重限流。',
 API_UNAVAILABLE: 'Spotify 播放控制通道暂时无法响应，本次状态读取未完成。',
 SOURCE_OBSERVATION_STALE: 'Spotify 返回的播放状态早于本次操作，未采用这份旧状态。',
 SEEK_UNCONFIRMED: 'Spotify 未确认已到达请求的播放进度，当前拖动进度操作未完成。',
 TRACK_UNAVAILABLE: 'Spotify 当前无法播放这首歌曲，可能因歌曲下架或账号所在地区不支持。',
 TRACK_NOT_CURRENT: 'Spotify 桌面当前歌曲与 Folia 请求的歌曲不同，请选择是否追随桌面播放。',
 DEVICE_ID_MISMATCH: 'Spotify 当前播放设备与本轮采集绑定的本机设备不同。',
 CAPTURE_BOOTSTRAP_TIMEOUT: '采集已开始，但未在等待时限内收到 Spotify 音频数据。',
 CAPTURE_OVERFLOW: '音频接收速度持续低于采集速度，缓存已满，未继续丢弃音频播放。',
 CAPTURE_PIPE_CLOSED: 'Spotify 音频传输通道在歌曲结束前关闭，本次音频未传输完整。',
 CAPTURE_FRAME_INVALID: '采集程序返回的音频块长度或帧边界无效，不能正确解释为音频。',
 CAPTURE_PROTOCOL_INVALID: '采集程序返回的数据结构与 Folia 约定不一致。',
 PROTOCOL_INVALID: 'Spotify 控制通道返回的数据缺少必要字段或格式不正确。',
 CONTROL_REJECTED: 'Spotify 拒绝了本次播放控制请求。',
 ROUTE_RESTORE_UNCONFIRMED: 'Spotify 原输出路由尚未确认恢复；已保留原路由记录以供继续恢复。',
 ROUTE_SOURCE_PAUSE_UNCONFIRMED: 'Spotify 暂停指令或随后状态回读未能确认暂停，当前会话仅保留清理权限；新的播放会先重新确认暂停与采集停止。',
 PLAYBACK_STATE_UNCONFIRMED: 'Spotify 回传的播放状态与本次操作要求不一致，尚未确认暂停、进度或准备状态；日志保留具体操作阶段。旧会话会先重新清理，不会要求重装组件。',
 DEVICE_INACTIVE: 'Spotify 当前未把本机作为活动播放设备，或本机设备信息尚未就绪。请在 Spotify 的设备列表选择这台电脑；桥接连接成功不代表本机正在接收音频。',
 PROCESS_CAPTURE_UNSUPPORTED: '当前 Windows 不支持 Spotify 进程专属采集，需要系统内部版本 20348 及以上；无需重装组件。',
 SPOTIFY_SETUP_STOP_FAILED: '配置前无法退出所选 Spotify，组件文件尚未修改。',
 SPOTIFY_SETUP_STOP_TIMEOUT: '已请求退出所选 Spotify，但进程或桥接连接未在 10 秒内结束，组件文件尚未修改。',
 ORIGINAL_ENDPOINT_UNSAFE: 'Spotify 的应用输出仍指向 VB-CABLE 或不可用设备，无法作为退出后的恢复目标；这与 Windows 默认输出是不同设置。',
 ORPHAN_ROUTE_RECORD_NOT_FOUND: 'Spotify 应用输出不可用，且没有找到可恢复的旧 Folia 路由记录。请在 Windows 音量混合器中把 Spotify 的输出改为“默认”。',
 ORPHAN_ROUTE_SOURCE_NOT_PAUSED: '旧 Folia 路由恢复尚未执行：Windows 未能确认原 Spotify 会话已静止（仍有活动会话或扫描证据不足）；这不表示组件未连接。',
 ORPHAN_ROUTE_RECOVERY_FAILED: '恢复上一轮 Folia 路由未完成，原路由记录已保留。',
 COMPLETE_SPOTIFY_DISCOVERY_REQUIRED: 'Windows 音频会话扫描未能确认 Spotify 的音频进程，播放尚未进入采集；桥接连接状态不受此错误影响。',
 EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN: 'Spotify 尚未建立可识别的音频会话，尚不能准备采集路由。',
 SPOTIFY_COMPONENT_RECEIPT_UNREADABLE: '组件配置记录无法读取，原配置和备份已保留。',
 SPOTIFY_EXTENSION_UPDATE_REQUIRED: '已检测到旧版 Folia 桥接扩展，一键配置将更新它；原备份保持不变。',
 SPOTIFY_CONFIGURATION_VERSION_CHANGED: '当前资源配置属于另一套 Spotify 安装，请为所选安装完成一键配置。',
 SPOTIFY_BACKUP_MISSING: '原资源目录没有可复用的 Spicetify 备份，无法无损升级；原目录已保留。',
 SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC: 'Wrapper 使用自动配置，请使用一键配置；旧手动保存操作不适用。',
 SPOTIFY_INSTANCE_CHANGED: '本次采集绑定的 Spotify 进程已退出或被新进程替换，旧会话不能继续使用；需要重新建立采集会话，这不等同于账号断开。',
 SPOTIFY_BRIDGE_NOT_READY: 'Spotify 已运行，但桥接在 30 秒内没有连接。请正常退出 Spotify，不要手动重新打开，再回到 Folia 重试，由 Folia 拉起带桥接资源的客户端。',
 SPOTIFY_OTHER_INSTALL_RUNNING: '运行中的 Spotify 与选定的桌面版或 Store 版不一致。请退出另一版本，或选择正在使用的版本。',
 SPOTIFY_PLAYER_NOT_READY: '桥接已连接，但 Spotify 尚未提供本机账号和播放设备。请在 Spotify 中完成登录。',
 SPOTIFY_COMPONENT_SETUP_REQUIRED: '所选 Spotify 的 Folia 资源目录缺失，请完成一键配置。',
 SPOTIFY_CABLE_SELECTION_REQUIRED: '没有识别到唯一的 VB-CABLE 输入输出设备对，无法确定采集设备。',
 NON_BASE_DEFAULT_OUTPUT_REQUIRED: 'Spotify 原输出没有可用的实际播放设备；Windows 默认输出不能是 VB-CABLE。',
 ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS: 'Spotify 原输出设备已断开或无法唯一识别，无法保存退出后的恢复目标。',
 ORIGINAL_PHYSICAL_OWNER_UNPROVEN: '无法确认 Spotify 原输出对应的实际设备，路由尚未修改。',
 ORIGINAL_EXPLICIT_ENDPOINT_CHANGED: 'Spotify 原输出设备在准备期间发生变化，路由尚未提交。',
 EXTERNAL_POLICY_CONFLICT: '其他程序或系统设置改变了 Spotify 的输出路由，当前路由操作未继续。',
 BOOTSTRAP_IDENTITY_UNCONFIRMED: '准备路由时未能确认 Spotify 本机音频进程。',
 PREPARED_SELECTION_INVALID_STATE: 'Spotify 准备步骤与当前会话状态不一致，新的采集尚未启动；需要结束未完成的准备后重新建立会话。',
 CAPTURE_INTERVAL_EPOCH_MISMATCH: '收到的 Spotify 操作属于旧准备轮次，不能用于当前采集会话；已保留当前路由与清理记录。',
 SOURCE_TRACK_CHANGED: 'Spotify 当前歌曲已改变，本次操作仍属于上一首歌曲；需要按当前歌曲重新准备，不能继续旧采集。',
 SEEK_PARK_EXPIRED: '拖动进度时保留的采集资源已超过有效期，需要停止旧采集后重新准备；不会复用过期音频。',
 SEEK_PARK_KEEPER_CHANGED: '拖动进度期间，保留的采集占位会话已变化，无法沿用旧资源；需要重新建立采集。',
 PREPARED_TARGET_ACTIVITY_REQUIRED: 'Spotify 本次播放准备记录缺失，或与当前进程、歌曲、采集模式及准备轮次不一致；尚未启动新的采集。重试将重新建立准备状态，无需重装组件。',
 PREPARED_TARGET_ACTIVITY_EXPIRED: 'Spotify 已收到播放指令，但 Windows 音频路由观察未在准备时限内完成；这不是组件未安装或账号未连接。',
 HQPLAYER_COMMAND_REJECTED: 'HQPlayer 拒绝了本次播放控制或旧会话停止指令；Spotify 桥接连接状态不受影响。',
 HQPLAYER_CONTROL_UNAVAILABLE: 'HQPlayer 控制连接中断或响应超时，旧输出会话尚需完成停止确认。',
 CAPTURE_HELPER_UNAVAILABLE: '随 Folia 提供的音频采集程序无法启动。',
 CAPTURE_STATE_INVALID: '音频采集设备与当前会话的格式或运行状态不一致，本次绑定未完成。',
 CAPTURE_STOP_TIMEOUT: '音频采集停止指令未获得确认，当前会话尚未完成清理；已保存的连接和组件配置仍保留。',
 CAPTURE_HELPER_CLOSED: '本轮 Spotify 音频采集进程已退出，音频传输中断；可重试播放以建立新的采集会话。',
 ROUTE_HELPER_UNAVAILABLE: '随 Folia 提供的音频路由程序无法启动。',
 PROTOCOL_INCOMPATIBLE: '采集组件协议与当前 Folia 不兼容，需要更新配套组件。',
 FORMAT_LEASE_READBACK_MISMATCH: '采集设备应用格式后的读回结果不一致，未建立音频采集。',
 SESSION_OBSERVATION_UNTRUSTED: 'Windows 音频会话观察未能确认本轮 Spotify 路由或静音占位会话，当前采集未启动；这不表示桥接未连接。',
 ROUTE_HELPER_CLOSED: '本轮音频路由进程已经退出，无法继续使用旧会话；已保存的组件配置与原路由备份仍保留。',
 SOURCE_EFFECT_UNKNOWN: '上一次 Spotify 控制指令未收到结果，尚不能确定播放状态。',
 CONTROL_TIMEOUT: 'Spotify 扩展未在规定时间内回应控制指令。',
 PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED: 'Spotify 已回报暂停，但旧路由组件未确认 Windows 音频会话静止；本次清理尚未完成。重试会重新核对并恢复会话，无需重新安装或配置。',
 PAUSED_SOURCE_SESSIONS_STILL_ACTIVE: 'Spotify 已回报暂停，但 Windows 仍将其音频会话标为活动；端点采集的暂停确认未完成。重试将重新检查会话状态。',
 PAUSED_SOURCE_OBSERVATION_INVALID: 'Spotify 暂停确认的 Windows 会话扫描不完整、时间已过期或进程不一致；本次未使用这份扫描结果。重试将重新采集状态。',
 PAUSED_SOURCE_OBSERVATION_TIMEOUT: 'Windows 音频会话暂停确认在 2 秒内未完成；重试将重新核对当前状态。',
 PAUSED_SOURCE_SCAN_INCOMPLETE: 'Windows 未返回完整的 Spotify 音频会话扫描，本轮采集基线未建立；重试会重新扫描。',
 PAUSED_SOURCE_PROCESS_MISMATCH: 'Windows 会话扫描中的进程与当前 Spotify 进程不一致，未将其他进程的状态作为本轮采集依据。',
 PAUSED_SOURCE_OBSERVATION_STALE: 'Windows 返回的音频会话快照早于本次请求，未使用过期快照；重试会重新读取。',
 PAUSED_SOURCE_OBSERVATION_IN_FUTURE: 'Windows 音频会话快照时间晚于当前时间，本次时间校验未通过；重试会重新读取。',
 PAUSED_SOURCE_SESSION_ID_MISSING: 'Windows 返回的 Spotify 音频会话缺少实例标识，本轮无法建立明确的采集基线。',
 FRESH_CAPTURE_INTERVAL_BASELINE_REQUIRED: '新采集尚未取得本轮有效的 Windows 会话基线，未复用暂停前的旧快照；可重试重新准备。',
 SOURCE_NOT_PAUSED: 'Spotify 当前仍在播放，暂停指令尚未获得本机状态确认；当前采集已停止，可重试恢复。',
 SOURCE_RESUMED_DURING_PAUSE_PROOF: '确认暂停期间 Spotify 又恢复了播放，本次状态已变化；可重试重新准备当前歌曲。',
 SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH: 'Spotify 返回的播放设备或状态时间与本次请求不一致，本次未采用旧状态；可重试重新读取。',
 PCM_STOP_NOT_CONFIRMED: '旧 Spotify 采集尚未确认停止，新的采集未启动；原路由记录保留。',
 OWNED_SILENT_RENDER_LEASE_NOT_STOPPED: '端点采集的静音占位会话仍显示活动，暂停清理未完成；这与 Spotify 是否连接无关。',
 SOURCE_BROKER_UNAVAILABLE: 'Spotify 暂停状态读取通道暂时不可用，旧会话尚未清理；可重试重新连接控制通道。',
 SOURCE_BROKER_FAILED: 'Spotify 控制通道未能完成暂停状态读取，旧会话尚未清理；可重试重新核对。',
 INVALID_AUDIO_REQUEST: 'Spotify 播放请求的歌曲编号、请求编号或音质参数未通过旧版入口校验；此错误发生在采集准备之前，与组件连接状态无关。',
 INVALID_AUDIO_TRACK_ID: 'Spotify 播放请求缺少有效的歌曲编号，尚未开始准备采集；这是歌曲数据传递错误。',
 INVALID_AUDIO_REQUEST_ID: 'Spotify 播放请求缺少有效的请求编号，尚未开始准备采集；这是 Folia 播放请求生成错误。',
 INVALID_AUDIO_QUALITY: 'Folia 传入了无法识别的音质偏好；应为标准、高品质、无损或 Hi-Res。Spotify 实际音质仍由其客户端决定。',
 HQPLAYER_MULTIPLE_INSTANCES: '检测到多个 HQPlayer 实例，无法确定目标输出实例。',
};
function failureDetails(error, operation) {
 const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : undefined;
 const nativeCode = safe(error?.nativeCode) || safe(error?.code);
 const causeCode = safe(error?.failureCode) || safe(error?.cause?.nativeCode) || safe(error?.cause?.code);
 const stage = typeof error?.stage === 'string' && /^[a-z0-9-]{1,64}$/.test(error.stage) ? error.stage : operation;
 const code = causeCode || nativeCode;
 const mismatchNames = { 'duration-mismatch': '歌曲时长不一致', 'position-invalid': '进度超出当前歌曲范围', 'playing-mismatch': '播放/暂停状态不一致' };
 const mismatch = Object.hasOwn(mismatchNames,error?.stateMismatch) ? error.stateMismatch : undefined;
 const stateFacts = {};
 if (mismatch) for (const key of ['expectedPlaying','actualPlaying','expectedDurationMs','actualDurationMs','actualPositionMs']) {
   const value=error[key]; if(typeof value==='boolean'||Number.isSafeInteger(value)&&value>=0&&value<=3600000) stateFacts[key]=value;
 }
 if (!code) return {};
 const recoveryText = code === 'PLAYBACK_STATE_UNCONFIRMED' && stage.startsWith('cleanup')
   ? '上一 Spotify 会话尚未完成暂停或清理，新的播放尚未开始；重试会重新核对旧会话，不会复用上次失败结果。' : undefined;
 const stageNames = { 'cleanup-previous-session': '停止上一轮采集', 'cleanup-required': '清理上一轮播放', 'scope': '读取本机播放状态', 'track-metadata': '读取歌曲信息', 'route-inspect': '检查应用输出路由', 'route-resume-preparation': '恢复采集准备', 'playback-facts': '确认播放状态', 'audio': '准备播放', 'browser-pcm': '交付音频' };
 const text = recoveryText || descriptions[code] || ((stageNames[stage] || '执行播放操作') + '未完成：组件没有提供已识别的原因，具体阶段及原始错误已记录在日志中。');
 const readback = code === 'FORMAT_LEASE_READBACK_MISMATCH'
   ? require('../debug/privatePreviewDiagnosticSchema.cjs').projectFormatLeaseReadback(error?.formatLeaseReadback) : undefined;
 const formatDetail = readback ? ` ${readback.endpointRole === 'render' ? '输出端' : '采集端'}请求 ${readback.requested.sampleRate} Hz／${readback.requested.channels} 声道，实际 ${readback.observed.sampleRate} Hz／${readback.observed.channels} 声道；差异字段：${readback.differingFields.map(field => ({ sampleRate: '采样率', channels: '声道数', bitsPerSample: '位深', validBitsPerSample: '有效位深', channelMask: '声道布局', formatTag: '格式标记', subFormat: '采样格式', blockAlign: '帧字节数', avgBytesPerSec: '每秒字节数' }[field] || '音频格式参数')).join('、')}。` : '';
 return { nativeCode, causeCode, stage, ...(error?.retriesExhausted === true ? { retryCount: 3, retriesExhausted: true } : {}), ...(mismatch ? { stateMismatch: mismatch, ...stateFacts } : {}), ...(readback ? { formatLeaseReadback: readback } : {}),
   ...(Number.isInteger(error?.hresult) ? { hresult: error.hresult } : {}),
   detail: text + (mismatch ? ' 具体差异：' + mismatchNames[mismatch] + '。' : '') + formatDetail + (error?.retriesExhausted === true ? ' 已自动重试三次，仍未恢复。' : '') };
}
module.exports = { failureDetails, descriptions };
