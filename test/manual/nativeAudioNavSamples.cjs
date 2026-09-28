// Real library samples, production transcode service; this is not App error orchestration.
async function runNavSamples(page, record) {
    const samples = await page.evaluate(async targeted => {
        const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
        const ids = ['3B7IskPYaj5cXacvfgF6IS', '0vkNVrR3Iqmso4JAUxoyDX'];
        const songs = targeted
            ? await Promise.all(ids.map(id => navidromeApi.getSong(getNavidromeConfig(), id)))
            : await navidromeApi.getRandomSongs(getNavidromeConfig(), 12);
        return songs.map(s => ({ id: s.id, title: s.title, suffix: s.suffix }));
    }, process.argv.includes('--nav-targeted'));
    for (const [index, song] of samples.entries()) await record(`navidrome-sample-${index + 1}`,
        '保留样本身份的真实曲库转码抽查', 'Production transcode sampling with retained track identity', async () => {
            const result = await page.evaluate(async song => {
                const { navidromeApi, getNavidromeConfig } = await import('/src/services/navidromeService.ts');
                const url = navidromeApi.getStreamUrl(getNavidromeConfig(), song.id, 'raw');
                const result = await window.electron.requestTranscodeFallback({
                    requestId: crypto.randomUUID(), priority: 'playback', limitBytes: 1024 ** 3,
                    source: { kind: 'navidrome', songKey: `navidrome:${song.id}`, sourceRevision: 'supplement-sample-v1', url, fileName: `source.${song.suffix}` },
                });
                return result.ok ? { ok: true, scheme: result.representation.url.split(':')[0] } : { ok: false, errorCode: result.errorCode,
                    detail: String(result.message || '').replace(/https?:\/\/\S+/g, '[URL]').replace(/[A-Z]:\\[^\n]+/g, '[local path]').slice(-1500) };
            }, song);
            return { status: result.ok && result.scheme === 'folia-transcode' ? 'PASS' : 'FAIL',
                trackId: song.id, title: song.title, suffix: song.suffix, ...result, layer: 'real-source-production-transcode-service' };
        });
}
module.exports = { runNavSamples };
