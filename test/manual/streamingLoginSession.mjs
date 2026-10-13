import { _electron as electron } from 'playwright';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Interactive login in the same isolated profile used by real playback acceptance tests.
// Only public authentication booleans are recorded; credentials stay in the provider vaults.
const directory = path.join(process.env.LOCALAPPDATA, 'FoliaSpotifyPreview');
const report = { startedAt: new Date().toISOString(), checks: [] };
const application = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
  args: [path.resolve('test/manual/spotifyAppPreview.cjs')], timeout: 60000 });
try {
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt++) {
    page = application.windows().find(window => window.url().startsWith('http://localhost:3000'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Preview window unavailable');
  await page.waitForTimeout(15000);
  await page.bringToFront();
  console.log('Please sign into QQ Music and NetEase Music using the normal account controls in the Folia preview window.');
  for (let attempt = 0; attempt < 60; attempt++) {
    const statuses = await page.evaluate(async () => {
      const { omni } = await import('/src/services/onlineMusic/omni.ts');
      const statuses = {};
      for (const provider of ['qq', 'netease', 'spotify']) {
        try { statuses[provider] = { authenticated: Boolean((await omni.getLoginStatus(provider))?.id) }; }
        catch (error) { statuses[provider] = { authenticated: false, errorCode: error.code || 'login-check-failed' }; }
      }
      return statuses;
    });
    report.checks.push({ checkedAt: new Date().toISOString(), statuses });
    console.log(JSON.stringify(report.checks.at(-1)));
    if (Object.values(statuses).every(status => status.authenticated)) { report.success = true; break; }
    await page.waitForTimeout(15000);
  }
} catch (error) { report.error = error.message; }
finally {
  await application.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `login-prerequisites-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(file);
  process.exitCode = report.success ? 0 : 1;
}
