import { _electron as electron } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Isolated real-app inspection; never attaches to the user's installed Folia or Chrome profile.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const report = { startedAt: new Date().toISOString(), stages: [] };
const application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000 });
try {
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    page = application.windows().find(window => window.url().startsWith('http://localhost:3000'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Folia app window did not open');
  await page.waitForLoadState('domcontentloaded');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  await page.evaluate(version => { localStorage.setItem('i18nextLng', 'en'); localStorage.setItem('active_online_provider_id', 'spotify');
    localStorage.setItem('folia_last_seen_ponder_onboarding_version', version); localStorage.setItem('static_mode', 'true'); localStorage.setItem('player_volume', '0.02'); }, version);
  await page.reload(); await page.waitForTimeout(18000);
  report.account = await page.evaluate(async () => {
    const { useOnlineProviderAccountStore } = await import('/src/stores/useOnlineProviderAccountStore.ts');
    const account = useOnlineProviderAccountStore.getState().accounts.spotify;
    return { status: account?.status, freshness: account?.freshness, collections: account?.collections?.length, error: account?.error };
  });
  report.inputs = await page.locator('input').evaluateAll(inputs => inputs.map(input => ({ placeholder: input.placeholder, type: input.type })));
  if (report.account.status !== 'authenticated' || report.account.collections < 1) throw new Error('Real Spotify account or library did not hydrate');
  report.liveLogin = await page.evaluate(async () => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    return Boolean((await omni.getLoginStatus('spotify'))?.id);
  });
  if (!report.liveLogin) throw new Error('Playback test blocked: Spotify login is not valid');
  await page.getByPlaceholder('SEARCH DATABASE...').fill('Mr. Brightside');
  await page.getByPlaceholder('SEARCH DATABASE...').press('Enter');
  await page.getByText('Mr. Brightside', { exact: true }).first().waitFor({ timeout: 45000 });
  report.stages.push({ stage: 'search', body: (await page.locator('body').innerText()).slice(0, 5000) });
  await page.evaluate(async () => {
    const { usePlaybackLoadStore } = await import('/src/stores/usePlaybackLoadStore.ts');
    window.spotifyTestProgress = [];
    window.spotifyTestUnsubscribe = usePlaybackLoadStore.subscribe(state => { if (state.progress) window.spotifyTestProgress.push(state.progress); });
  });
  await page.getByRole('button', { name: 'Play track', exact: true }).first().click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('audio')).some(audio => !audio.paused && audio.currentTime > 1), null, { timeout: 90000 });
  report.playback = await page.evaluate(async () => {
    window.spotifyTestUnsubscribe();
    const { usePlaybackStore } = await import('/src/stores/usePlaybackStore.ts');
    const state = usePlaybackStore.getState();
    return { provider: state.currentSong?.sourceRef?.providerId, song: state.currentSong?.name, state: state.playerState,
      clocks: Array.from(document.querySelectorAll('audio')).filter(audio => !audio.paused).map(audio => audio.currentTime), stages: window.spotifyTestProgress };
  });
  if (report.playback.provider !== 'spotify' || report.playback.state !== 'PLAYING') throw new Error('Real Spotify playback did not reach the Folia deck');
  report.buttons = await page.getByRole('button').evaluateAll(buttons => buttons.map(button => ({ text: button.innerText, label: button.getAttribute('aria-label'), title: button.title })).slice(0, 40));
  report.stages.push({ stage: 'loaded', title: await page.title(), body: (await page.locator('body').innerText()).slice(0, 9000) });
  await page.screenshot({ path: path.join(directory, 'app-preview.png') });
  report.loginAfter = await page.evaluate(async () => {
    const { omni } = await import('/src/services/onlineMusic/omni.ts');
    return Boolean((await omni.getLoginStatus('spotify'))?.id);
  });
  if (!report.loginAfter) throw new Error('Playback acceptance invalidated: Spotify login no longer valid');
  report.success = true;
} catch (error) { report.success = false; report.error = String(error.message).slice(0, 300); }
finally {
  await application.close(); report.finishedAt = new Date().toISOString(); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `app-smoke-${Date.now()}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exitCode = report.success ? 0 : 1;
}
