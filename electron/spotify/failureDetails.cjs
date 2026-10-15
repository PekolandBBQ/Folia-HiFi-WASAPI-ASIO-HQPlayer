'use strict';
// Preserve bounded machine codes across IPC; messages explain the failed operation without exposing account data.
const descriptions = {
 DEVICE_INACTIVE: 'Spotify 当前未把本机作为活动播放设备，或本机设备信息尚未就绪。请在 Spotify 的设备列表选择这台电脑；桥接连接成功不代表本机正在接收音频。',
 PROCESS_CAPTURE_UNSUPPORTED: '当前 Windows 不支持 Spotify 进程专属采集，需要系统内部版本 20348 及以上；无需重装组件。',
 SPOTIFY_SETUP_STOP_FAILED: '配置前无法退出所选 Spotify，组件文件尚未修改。',
 SPOTIFY_SETUP_STOP_TIMEOUT: '已请求退出所选 Spotify，但进程或桥接连接未在 10 秒内结束，组件文件尚未修改。',
 ORIGINAL_ENDPOINT_UNSAFE: 'Spotify 的应用输出仍指向 VB-CABLE 或不可用设备，无法作为退出后的恢复目标；这与 Windows 默认输出是不同设置。',
 ORPHAN_ROUTE_RECORD_NOT_FOUND: 'Spotify 应用输出不可用，且没有找到可恢复的旧 Folia 路由记录。请在 Windows 音量混合器中把 Spotify 的输出改为“默认”。',
 ORPHAN_ROUTE_SOURCE_NOT_PAUSED: '旧 Folia 路由恢复尚未执行：Spotify 音频会话仍在播放。',
 ORPHAN_ROUTE_RECOVERY_FAILED: '恢复上一轮 Folia 路由未完成，原路由记录已保留。',
 COMPLETE_SPOTIFY_DISCOVERY_REQUIRED: 'Windows 音频会话扫描未能确认 Spotify 的音频进程，播放尚未进入采集；桥接连接状态不受此错误影响。',
 EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN: 'Spotify 尚未建立可识别的音频会话，尚不能准备采集路由。',
 SPOTIFY_COMPONENT_RECEIPT_UNREADABLE: '组件配置记录无法读取，原配置和备份已保留。',
 SPOTIFY_EXTENSION_UPDATE_REQUIRED: '已检测到旧版 Folia 桥接扩展，一键配置将更新它；原备份保持不变。',
 SPOTIFY_CONFIGURATION_VERSION_CHANGED: '当前资源配置属于另一套 Spotify 安装，请为所选安装完成一键配置。',
 SPOTIFY_BACKUP_MISSING: '原资源目录没有可复用的 Spicetify 备份，无法无损升级；原目录已保留。',
 SPOTIFY_WRAPPER_SETTINGS_AUTOMATIC: 'Wrapper 使用自动配置，请使用一键配置；旧手动保存操作不适用。',
 SPOTIFY_INSTANCE_CHANGED: '与 Spotify 扩展的连接已断开，当前请求未完成。请重新连接 Spotify。',
 SPOTIFY_BRIDGE_NOT_READY: 'Spotify 已运行，但 Folia 桥接扩展在 30 秒内没有连接。请完成一键配置后重启 Spotify。',
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
 HQPLAYER_MULTIPLE_INSTANCES: '检测到多个 HQPlayer 实例，无法确定目标输出实例。',
};
function failureDetails(error, operation) {
 const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(value) ? value : undefined;
 const nativeCode = safe(error?.nativeCode) || safe(error?.code);
 const causeCode = safe(error?.failureCode) || safe(error?.cause?.nativeCode) || safe(error?.cause?.code);
 const stage = typeof error?.stage === 'string' && /^[a-z0-9-]{1,64}$/.test(error.stage) ? error.stage : operation;
 const code = causeCode || nativeCode;
 if (!code) return {};
 const text = descriptions[code] || 'Spotify 操作未完成，以下为组件返回的具体错误。';
 const readback = code === 'FORMAT_LEASE_READBACK_MISMATCH'
   ? require('../debug/privatePreviewDiagnosticSchema.cjs').projectFormatLeaseReadback(error?.formatLeaseReadback) : undefined;
 const formatDetail = readback ? ` ${readback.endpointRole === 'render' ? '输出端' : '采集端'}请求 ${readback.requested.sampleRate} Hz／${readback.requested.channels} 声道，实际 ${readback.observed.sampleRate} Hz／${readback.observed.channels} 声道；差异字段：${readback.differingFields.join('、')}。` : '';
 return { nativeCode, causeCode, stage, ...(readback ? { formatLeaseReadback: readback } : {}),
   ...(Number.isInteger(error?.hresult) ? { hresult: error.hresult } : {}),
   detail: text + formatDetail + ' [' + [stage, nativeCode, causeCode].filter(Boolean).join(' / ') + ']' };
}
module.exports = { failureDetails };
