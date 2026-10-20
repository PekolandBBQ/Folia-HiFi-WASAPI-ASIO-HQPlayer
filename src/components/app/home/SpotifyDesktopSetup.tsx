import SpotifyExitSetting from './SpotifyExitSetting';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { spotifyActivation } from '../../../services/onlineMusic/spotifyActivation';
import { requestSpotify } from '../../../services/onlineMusic/spotifyTransport';
import { type DesktopSetupStatus, installError, installPhase } from './spotifyDesktopSetupModel';
// Wrapper prerequisites stay visible even without a running or authenticated desktop.
export default function SpotifyDesktopSetup({ onMode, onReady, finishing = false, showCompletion = true }: { onMode: (enabled: boolean) => void; onReady: () => void; finishing?: boolean; showCompletion?: boolean }) {
    const [status, setStatus] = useState<DesktopSetupStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const selected = useSyncExternalStore(spotifyActivation.subscribe, spotifyActivation.selected, spotifyActivation.selected);
    async function run(operation: 'status' | 'choose' | 'open' | 'launch' | 'install' | 'configure' = 'status', extra: Record<string, string> = {}) {
        setBusy(true); setError('');
        try {
            const value = await requestSpotify<DesktopSetupStatus>({ action: 'desktopSetup', operation, ...extra });
            if ((value as unknown as { spotifyError?: { detail?: string; message?: string } })?.spotifyError) { const failure = (value as unknown as { spotifyError: { detail?: string; message?: string } }).spotifyError; throw new Error(failure.detail || failure.message || 'SPOTIFY_SETUP_FAILED'); }
            if (value?.enabled) { setStatus(value); onMode(true); }
            else { onMode(true); setError('无法完成本机组件检测，请重新检查。'); }
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'SPOTIFY_SETUP_FAILED'); }
        finally { setBusy(false); }
    }
    useEffect(() => { onMode(true); if (selected) void run(); }, [selected]);
    useEffect(() => {
        if (!status || busy) return;
        const timer = setTimeout(() => void run(), status.install.busy ? 1500 : 5000);
        return () => clearTimeout(timer);
    }, [status, busy]);
    if (!selected) return <section aria-label="Spotify 组件安装向导" className="space-y-3 text-sm">
        <p>本次尚未选择 Spotify。选择后会自动准备组件并连接，其他音源不受影响。</p>
        <button className="spotify-setup-button rounded-full border px-4 py-2 text-xs" onClick={() => spotifyActivation.select()}>连接 Spotify</button>
    </section>;
    if (!status) return <section aria-label="Spotify 组件安装向导" className="space-y-3 text-sm">
        <p role="status">{busy ? '正在检测 Spotify 和本机组件…' : error || '组件检测尚未完成。'}</p>
        <button className="spotify-setup-button rounded-full border px-4 py-2 text-xs" disabled={busy} onClick={() => void run()}>重新检查</button>
    </section>;
    const button = 'spotify-setup-button rounded-full border px-4 py-2 text-xs';
    return <section className="space-y-3 text-sm" aria-label="Spotify 组件安装向导">
        <SpotifyExitSetting />
        <h4 className="font-medium">准备 Spotify 本机播放</h4>
        <p className="spotify-setup-hint text-xs">组件包 {status.bundleVersion} · Spicetify {status.versions.spicetify} · VB-CABLE {status.versions.cable}</p>
        <p className="spotify-setup-hint text-xs">每次安装前联网核对 Folia 已验证组件清单，并检查已有文件；版本一致且完整才复用。</p>
        {!status.installations.length && <p role="alert">{status.detectionFailed ? '安装检测失败，尚不能确定是否安装。' : '未检测到 Spotify。请自行安装官网桌面版或 Microsoft Store 版，并登录账号。'}</p>}
        {status.installations.map(item => <button disabled={busy || status.install.busy} className={button} key={item.id} onClick={() => void run('choose', { installation: item.id })}>
            {item.layout === 'store' ? 'Microsoft Store 版' : '官网桌面版'} {item.version}{status.selected === item.id ? ' · 已选择' : ''}</button>)}
        <ul className="space-y-1 text-xs">
            <li>Spicetify：{status.wrapper ? '已准备' : status.cli ? '已安装，待配置' : '待安装并配置'}</li>
            <li>Spotify 连接组件：{status.extension ? '已准备' : '待配置'}</li>
            <li>VB-CABLE：{status.driverCurrent === false ? '版本需更新，请完成一键安装' : status.driver ? '已检测到驱动设备' : '尚未检测到驱动设备'}</li>
            <li>音频输入输出：{status.driverEndpointsReady ? '已识别完整设备对' : '尚未就绪'}</li>
            <li>采集与路由组件：{status.engine ? '已准备' : '待安装'}</li>
            <li>Spotify 连接：{busy ? '正在连接…' : status.connected && status.bridgeRuntime?.state === 'ready' ? '已连接，可搜索和收藏歌曲' : status.running ? '尚未连接，Folia 会在使用时自动处理' : '尚未启动，使用时将自动连接'}</li>
        </ul>
        {status.issues?.map((issue, index) => <p role="alert" className="text-xs" key={index}>{issue.detail || `${issue.stage}: ${issue.nativeCode}`}</p>)}
        <p role="status" className="text-xs">音频链路：{status.playback?.state === 'failed' ? status.playback.detail || '最近播放失败，尚未获得具体组件错误。' : status.playback?.state === 'prepared' ? '音源准备已完成；不代表已确认实际出声。' : '尚未实播；组件和连接检查不代表音频输出通过。'}</p>
        {status.systemOutput?.state !== 'ready' && <div role="status" className="space-y-2 rounded-xl border p-3 text-xs">
            <p>{status.systemOutput?.state === 'cable' ? 'Windows 默认输出当前是 VB-CABLE。Spotify 使用进程专属采集，不影响 Folia 已选择的 ASIO、WASAPI 或 HQPlayer 输出。' : '暂未取得 Windows 默认输出信息；Spotify 进程专属采集不依赖此检查。'}</p>
            {!!status.systemOutput?.names.length && <p>当前输出：{status.systemOutput.names.join('、')}</p>}
            <p>HQPlayer 或独占驱动占用唯一的 DAC 时，可继续播放，无需额外的 Windows 输出设备。其他程序的声音不会通过 Spotify 采集进入 Folia。</p>
            <p>如需听到其他程序的声音，可在有其他实际设备时调整 Windows 输出；这不是 Spotify 播放的前置步骤。</p>
            <button className={button} disabled={busy} onClick={() => void run('open', { component: 'sound' })}>打开系统声音设置</button>
        </div>}
        {status.systemOutput?.state === 'ready' && <p className="text-xs">Windows 默认输出检查通过：{status.systemOutput.names.join('、')}</p>}
        <div className="flex flex-wrap gap-2">
            {!status.installations.length && <button className={button} disabled={busy} onClick={() => void run('open', { component: 'spotify' })}>前往 Spotify 下载页</button>}
            <button className={button} disabled={busy || status.install.busy || status.install.restartRequired || !status.selected} onClick={() => void run('install')}>① 一键安装</button>
            <button className={button} disabled={busy || status.install.busy || status.install.restartRequired || !status.selected || !status.cli || status.driverCurrent === false || !status.driverEndpointsReady || !status.engine} onClick={() => void run('configure')}>② 一键配置</button>
            {!status.connected && status.wrapper && status.extension && <button className={button} disabled={busy || status.install.busy} onClick={() => void run('launch')}>启动并连接 Spotify</button>}
            <button className={button} disabled={busy} onClick={() => void run()}>{busy ? '正在检查…' : '重新检查'}</button>
            {status.ready && showCompletion && <button className={button} disabled={busy || finishing || status.install.busy} onClick={onReady}>{finishing ? '正在确认…' : '完成并返回歌单'}</button>}
        </div>
        <p role="status" className="text-xs">{status.install.phase === 'failed' ? status.install.detail || (installError[status.install.code || ''] || '组件操作未完成，进度已保存。') + ` [${status.install.code || 'SPOTIFY_COMPONENT_SETUP_FAILED'}]` : status.install.phase === 'complete' && status.connected ? '配置已完成，Spotify 桥接已连接。' : installPhase[status.install.phase] || '正在准备组件…'}</p>
        <p className="spotify-setup-hint text-xs">一键配置会先恢复原输出并退出所选 Spotify，配置后自动在后台启动和连接；无需另行启动。已有配置保留。</p>
        <p className="spotify-setup-hint text-xs">复用已有组件、配置和备份。Spotify 由你自行安装；登录和驱动安装提示需由你操作。</p>
        <p className="spotify-setup-hint text-xs">首次安装或重装 VB-CABLE 后需要重启 Windows，请先保存其他工作。重启后重新检查驱动和音频设备，再继续一键配置；能识别设备不代表已验证实际出声。</p>
        {error && <p role="alert">{error}</p>}
    </section>;
}
