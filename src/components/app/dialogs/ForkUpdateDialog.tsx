import ThemedDialog from '../../shared/ThemedDialog';
import { useForkUpdatePrompt } from '../../../hooks/useForkUpdatePrompt';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { formatForkVersion } from '../../modal/settings/ForkAbout';

// Release notes and explicit download/install choices, independent of audio playback.
export default function ForkUpdateDialog() {
    const update = useForkUpdatePrompt();
    const isDaylight = useThemeSettingsStore(state => state.isDaylight);
    const status = update.status;
    if (!status?.forkUpdate) return null;
    const downloading = status.status === 'downloading';
    const downloaded = status.status === 'downloaded';
    const button = 'rounded-full px-4 py-2 text-sm bg-white/10 border border-current/20 disabled:opacity-50';
    return <ThemedDialog isOpen={update.open} onClose={update.close} isDaylight={isDaylight}
        title="Folia HiFi 有可用更新" description={formatForkVersion(status.availableVersion || '')}
        maxWidthClass="max-w-xl"
        footer={<div className="flex flex-wrap justify-end gap-2">
            <button className={button} onClick={update.close}>{downloading ? '后台下载' : '稍后再说'}</button>
            {downloaded && status.autoUpdateSupported
                ? <button className={button} disabled={update.busy} onClick={() => void update.install()}>退出并更新</button>
                : !downloaded && <button className={button} disabled={update.busy || downloading} onClick={() => void update.download()}>
                    {downloading ? `正在下载 ${Math.round(status.downloadProgress?.percent || 0)}%` : '下载更新'}
                </button>}
        </div>}>
        <div className="max-h-72 overflow-auto whitespace-pre-wrap text-sm leading-relaxed">{status.releaseNotes?.trim() || '此版本未提供更新说明。'}</div>
        <p className="mt-4 text-sm opacity-70">{downloaded
            ? status.autoUpdateSupported ? '安装包已就绪。确认更新后会停止播放并退出，配置和备份保留。' : '便携包已下载，请退出旧版后解压使用。'
            : '是否下载此更新？下载不会中断播放，安装前还需确认。'}</p>
        {(update.error || status.error) && <p role="alert" className="mt-3 text-sm text-amber-500">{update.error || status.error}</p>}
    </ThemedDialog>;
}
