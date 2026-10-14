import { useEffect, useState } from 'react';
import { type DesktopSetupStatus, installError, installPhase } from './spotifyDesktopSetupModel';
// Wrapper prerequisites stay visible even without a running or authenticated desktop.
export default function SpotifyDesktopSetup({ onMode, onReady, finishing = false, showCompletion = true }: { onMode: (enabled: boolean) => void; onReady: () => void; finishing?: boolean; showCompletion?: boolean }) {
    const [status, setStatus] = useState<DesktopSetupStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    async function run(operation: 'status' | 'choose' | 'open' | 'launch' | 'install' | 'configure' = 'status', extra: Record<string, string> = {}) {
        setBusy(true); setError('');
        try {
            const value = await window.electron?.spotify?.request({ action: 'desktopSetup', operation, ...extra }) as DesktopSetupStatus | undefined;
            if ((value as unknown as { spotifyError?: { detail?: string; message?: string } })?.spotifyError) { const failure = (value as unknown as { spotifyError: { detail?: string; message?: string } }).spotifyError; throw new Error(failure.detail || failure.message || 'SPOTIFY_SETUP_FAILED'); }
            if (value?.enabled) { setStatus(value); onMode(true); }
            else { onMode(true); setError('无法完成本机组件检测，请重新检查。'); }
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'SPOTIFY_SETUP_FAILED'); }
        finally { setBusy(false); }
    }
    useEffect(() => { onMode(true); void run(); }, []);
    useEffect(() => {
        if (!status || busy) return;
        const timer = setTimeout(() => void run(), status.install.busy ? 1500 : 5000);
        return () => clearTimeout(timer);
    }, [status, busy]);
    if (!status) return <section aria-label="Spotify 组件安装向导" className="space-y-3 text-sm">
        <p role="status">{busy ? '正在检测 Spotify 和本机组件…' : error || '组件检测尚未完成。'}</p>
        <button className="spotify-setup-button rounded-full border px-4 py-2 text-xs" disabled={busy} onClick={() => void run()}>重新检查</button>
    </section>;
    const button = 'spotify-setup-button rounded-full border px-4 py-2 text-xs';
    return <section className="space-y-3 text-sm" aria-label="Spotify 组件安装向导">
        <h4 className="font-medium">准备 Spotify 本机播放</h4>
        <p className="spotify-setup-hint text-xs">组件包 {status.bundleVersion} · Spicetify {status.versions.spicetify} · VB-CABLE {status.versions.cable}</p>
        <p className="spotify-setup-hint text-xs">每次安装前联网核对 Folia 已验证组件清单，并检查已有文件；版本一致且完整才复用。</p>
        {!status.installations.length && <p role="alert">{status.detectionFailed ? '安装检测失败，尚不能确定是否安装。' : '未检测到 Spotify。请自行安装官网桌面版或 Microsoft Store 版，并登录账号。'}</p>}
        {status.installations.map(item => <button disabled={busy || status.install.busy} className={button} key={item.id} onClick={() => void run('choose', { installation: item.id })}>
            {item.layout === 'store' ? 'Microsoft Store 版' : '官网桌面版'} {item.version}{status.selected === item.id ? ' · 已选择' : ''}</button>)}
        <ul className="space-y-1 text-xs">
            <li>Spicetify：{status.wrapper ? '已准备' : status.cli ? '已安装，待配置' : '待安装并配置'}</li>
            <li>Folia 桥接扩展：{status.extension ? '已准备' : '待配置'}</li>
            <li>VB-CABLE：{status.driverCurrent === false ? '版本需更新，请完成一键安装' : status.driver ? '已检测到驱动设备' : '尚未检测到驱动设备'}</li>
            <li>音频输入输出：{status.driverEndpointsReady ? '已识别完整设备对' : '尚未就绪'}</li>
            <li>采集与路由组件：{status.engine ? '已准备' : '待安装'}</li>
            <li>本机桥接：{status.connected ? '已连接' : status.running ? '等待连接' : 'Spotify 尚未启动'}</li>
        </ul>
        {status.issues?.map((issue, index) => <p role="alert" className="text-xs" key={index}>{issue.detail || `${issue.stage}: ${issue.nativeCode}`}</p>)}
        <p role="status" className="text-xs">音频链路：{status.playback?.state === 'failed' ? status.playback.detail || '最近播放失败，尚未获得具体组件错误。' : status.playback?.state === 'prepared' ? '音源准备已完成；不代表已确认实际出声。' : '尚未实播；组件和连接检查不代表音频输出通过。'}</p>
        {status.systemOutput?.state !== 'ready' && <div role="alert" className="space-y-2 rounded-xl border p-3 text-xs">
            <p>{status.systemOutput?.state === 'cable' ? 'Windows 默认输出当前是 VB-CABLE。请选择实际扬声器或 DAC 后再继续。' : '尚无法确认 Windows 默认输出，请检查已连接的扬声器或 DAC。'}</p>
            {!!status.systemOutput?.names.length && <p>当前输出：{status.systemOutput.names.join('、')}</p>}
            <p>打开系统声音设置，在“输出”中选择你平时使用的设备，不要选择 CABLE Input 或 CABLE In 16ch。完成后返回此处点击“重新检查”。Folia 内的播放后端设置不能代替这一步。</p>
            <p>若 HQPlayer 或独占驱动运行时 DAC 暂时从 Windows 输出列表消失，请为 Windows 选择另一个可用的实际输出；HQPlayer 的 DAC 选择保持独立。没有其他输出时，请先退出占用设备的程序，再重新检查。</p>
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
