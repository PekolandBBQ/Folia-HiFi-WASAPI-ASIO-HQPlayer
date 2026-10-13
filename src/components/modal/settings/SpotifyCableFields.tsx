import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderCableSelection, ProviderPlaybackSetupAction } from '../../../types/onlineMusic';
import { spotifyPlaybackSetup } from '../../../services/onlineMusic/spotifyPlaybackSetup';
import { EMPTY_CABLE_SELECTION } from '../../../services/onlineMusic/spotifyCableSetup';
import { useSpotifyPlaybackSetup } from '../../../hooks/useSpotifyPlaybackSetup';
import './SpotifySetupAppearance.css';

// First setup and settings share explicit selections; merely opening the view never installs or changes a route.
export const cableButtonClass = 'spotify-setup-button rounded-full border px-4 py-2 text-xs';
export default function SpotifyCableFields({ section = 'all' }: { section?: 'desktop' | 'cable' | 'all' }) {
    const { t } = useTranslation();
    const { status, busy } = useSpotifyPlaybackSetup(state => state);
    const saved = JSON.stringify(status?.selection || EMPTY_CABLE_SELECTION);
    const [selection, setSelection] = useState<ProviderCableSelection>(() => ({ ...EMPTY_CABLE_SELECTION, ...status?.selection }));
    useEffect(() => { setSelection(JSON.parse(saved)); }, [saved]);
    useEffect(() => { void spotifyPlaybackSetup.run({ operation: 'devices' }); }, []);
    const showDesktop = section === 'all' || section === 'desktop', showCable = section === 'all' || section === 'cable';
    const dirty = JSON.stringify(selection) !== saved;
    const select = (key: 'connectDeviceId' | 'captureDeviceId' | 'renderDeviceId', value: string) => setSelection(previous =>
        previous[key] === value ? previous : { ...previous, [key]: value, spotifyOnlyConfirmed: false,
            internal44100Confirmed: key === 'connectDeviceId' ? previous.internal44100Confirmed : false });
    const action = (operation: ProviderPlaybackSetupAction, label: string) => <button type="button" className={cableButtonClass}
        disabled={!spotifyPlaybackSetup.canRun(operation)} onClick={() => void spotifyPlaybackSetup.run({ operation })}>{t(`spotifyCable.${label}`)}</button>;
    const endpoint = (key: 'captureDeviceId' | 'renderDeviceId', label: string) => <label className="block space-y-1 text-xs">
        <span>{t(`spotifyCable.${label}`)}</span>
        <select className="spotify-cable-select w-full rounded-lg border px-3 py-2" aria-label={t(`spotifyCable.${label}`)}
            disabled={busy} value={selection[key]} onChange={event => select(key, event.target.value)}>
            <option value="">{t('spotifyCable.select')}</option>
            {(status?.devices?.[key === 'captureDeviceId' ? 'capture' : 'render'] || []).map(device =>
                <option key={device.id} value={device.id}>{device.name} · {device.id.slice(-6)}</option>)}
        </select>
    </label>;
    const confirm = (key: 'internal44100Confirmed' | 'spotifyOnlyConfirmed') => <label className="flex items-start gap-2 text-xs leading-relaxed">
        <input type="checkbox" className="mt-0.5" required disabled={busy} checked={selection[key]}
            onChange={event => setSelection(previous => ({ ...previous, [key]: event.target.checked }))} />
        <span>{t(`spotifyCable.${key}`)}</span>
    </label>;
    const format = (value?: number) => value ? `${value / 1000} kHz` : t('spotifyCable.unknown');
    return <div className="spotify-cable-fields space-y-3" data-testid={`spotify-cable-fields-${section}`}>
        {showDesktop && <>
            <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.desktopHint')}</p>
            <p className="text-xs" role="status">{t(status?.spotifyRunning ? 'spotifyCable.desktopRunning' : 'spotifyCable.desktopMissing')}</p>
            {status?.code === 'DEVICE_INACTIVE' && <p role="status" className="text-xs leading-relaxed">{t('spotifyCable.inactiveHint')}</p>}
            <label className="block space-y-1 text-xs"><span>{t('spotifyCable.connectDevice')}</span>
                <select className="spotify-cable-select w-full rounded-lg border px-3 py-2" aria-label={t('spotifyCable.connectDevice')}
                    disabled={busy} value={selection.connectDeviceId} onChange={event => select('connectDeviceId', event.target.value)}>
                    <option value="">{t('spotifyCable.select')}</option>
                    {(status?.devices?.spotify || []).map((device, index) => <option key={device.id || `unknown-${index}`}
                        value={device.id || ''} disabled={!device.selectable}>{device.name} · {device.id?.slice(-6) || '?'}
                        {device.isActive ? ` (${t('spotifyCable.active')})` : ''}</option>)}
                </select>
            </label>
        </>}
        {showCable && <>
            <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.routeHint')}</p>
            <div className="spotify-setup-surface space-y-2 rounded-xl border p-3">
                {status?.driverInstalled && <p className="text-xs leading-relaxed">{t('spotifyCable.endpointsDetectedHint')}</p>}
                <p className="text-xs leading-relaxed">{t(status?.driverBundled && status.driverInstallerAvailable
                    ? 'spotifyCable.installHint' : 'spotifyCable.driverNotBundled')}</p>
                {action('openDriver', 'install')}
            </div>
            <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.defaultWarning')}</p>
            {endpoint('renderDeviceId', 'renderEndpoint')}
            {endpoint('captureDeviceId', 'captureEndpoint')}
            <fieldset className="spotify-setup-surface space-y-2 rounded-xl border p-3">
                <legend className="px-1 text-xs font-medium">{t('spotifyCable.clientSetupTitle')}</legend>
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
                    <li>{t('spotifyCable.clientOutputStep')}</li>
                    <li>{t('spotifyCable.exclusiveHint')}</li>
                </ol>
                {confirm('spotifyOnlyConfirmed')}
                <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.clientSetupSavedHint')}</p>
            </fieldset>
            <div className="flex flex-wrap gap-2">{action('openCablePanel', 'cablePanel')}</div>
            <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.internalHint')}</p>
            {confirm('internal44100Confirmed')}
            <p className="spotify-setup-hint text-xs leading-relaxed">{t('spotifyCable.vendor')}{' '}
                <a className="underline" href="https://vb-audio.com/Cable/index.htm" target="_blank" rel="noreferrer">www.vb-cable.com</a>{' · '}
                <a className="underline" href="https://shop.vb-audio.com/en/win-apps/11-vb-cable.html" target="_blank" rel="noreferrer">{t('spotifyCable.donate')}</a>
            </p>
        </>}
        <div className="flex flex-wrap gap-2">
            {action('devices', 'refreshDevices')}
            <button type="button" className={cableButtonClass} disabled={busy || !dirty || !spotifyPlaybackSetup.canRun('saveSelection')}
                onClick={() => void spotifyPlaybackSetup.run({ operation: 'saveSelection', selection })}>{t('spotifyCable.save')}</button>
        </div>
        {section === 'all' && <details className="space-y-3 text-xs">
            <summary className="cursor-pointer">{t('spotifyCable.audioDetails')}</summary>
            <p className="spotify-setup-hint leading-relaxed">{t('spotifyCable.verifyHint')}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1" aria-label={t('spotifyCable.observedFormat')}>
                <dt>{t('spotifyCable.renderMix')}</dt><dd>{format(status?.probe?.renderMixSampleRate)}</dd>
                <dt>{t('spotifyCable.captureMix')}</dt><dd>{format(status?.probe?.captureMixSampleRate)}</dd>
                <dt>{t('spotifyCable.captureRate')}</dt><dd>{format(status?.probe?.captureSampleRate)}</dd>
                <dt>{t('spotifyCable.routing')}</dt><dd>{t(status?.probe?.routeVerified ? 'spotifyCable.verified' : 'spotifyCable.unverified')}</dd>
            </dl>
            <p className="spotify-setup-hint leading-relaxed">{t('spotifyCable.qualityHint')}</p>
            <p className="spotify-setup-hint leading-relaxed">{t('spotifyCable.temporaryHint')}</p>
            <div className="flex flex-wrap gap-2">{action('openSoundSettings', 'soundSettings')}{action('stop', 'stop')}</div>
        </details>}
    </div>;
}
