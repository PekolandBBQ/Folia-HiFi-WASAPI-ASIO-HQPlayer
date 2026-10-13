import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assertHQPlayerWindowVisibility } = createRequire(import.meta.url)('./hqplayerWindowState.cjs');

// Exercises the real controls and handoff coordinator without restarting a song to hide failures.
export async function applyCurrentDsp(page, snapshot) {
  const before = await snapshot();
  const trigger = page.getByRole('button', { name: 'HQPlayer settings', exact: true });
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const panel = page.getByRole('region', { name: 'HQPlayer upsampling', exact: true });
  const apply = panel.getByRole('button', { name: 'Apply to current song', exact: true });
  await apply.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Apply to current song' && !button.disabled));
  // Reapply the selected settings, preserving the listener's filter/rate choices.
  await page.evaluate(() => { window.outputRegression.events.length = 0; });
  await apply.click();
  await panel.getByText('Applied; playback position preserved.', { exact: true }).waitFor({ timeout: 75000 });
  await page.waitForFunction(position => {
    const q = window.outputRegression;
    return q.player.getState().playerState === 'PLAYING' && q.clock.get() > position + 1;
  }, before.position, { timeout: 75000 });
  const after = await snapshot();
  assert.equal(after.id, before.id); assert.deepEqual(after.errors, []);
  const first = await page.evaluate(() => window.outputRegression.events.find(event => event.event === 'resume')?.state);
  assert.ok(first?.playing && first.position >= before.position - 1, 'DSP did not resume the existing position');
  await panel.getByRole('button', { name: 'Close signal path', exact: true }).click();
  return { mode: 'hqplayer-apply-current', pass: true, before, after, resumed: first.position };
}

async function seekThroughProgressControl(page, seconds) {
  const range = page.locator('[data-ponder="player-bar"] [data-folium-part="progress.track"] input[type="range"]');
  await range.hover(); await page.waitForTimeout(400);
  const maximum = Number(await range.getAttribute('max')), bounds = await range.boundingBox();
  assert.ok(Number.isFinite(maximum) && maximum > seconds && bounds?.width > 10, 'Song progress control is unavailable');
  await range.evaluate(input => {
    window.outputRegression.progressSelection = null;
    input.addEventListener('input', event => {
      window.outputRegression.progressSelection = { value: Number(input.value), trusted: event.isTrusted };
    }, { once: true });
  });
  // A real pointer action exercises onSeekStart/input/onSeekEnd and the native adapter.
  await range.click({ position: { x: Math.max(1, Math.min(bounds.width - 1, bounds.width * seconds / maximum)), y: bounds.height / 2 } });
  const selection = await page.evaluate(() => window.outputRegression.progressSelection);
  // Native range thumb geometry can shift a pointer's numeric value. Verify the actual trusted
    // selection and its resumed checkpoint, rather than substituting a programmatic seek.
  assert.ok(selection?.trusted && Number.isFinite(selection.value) && selection.value > .5 && selection.value < seconds + 2,
    'Progress click did not select a real earlier nonzero checkpoint');
  return selection.value;
}

export async function checkOutputLifecycle(page, selected, snapshot, observeHQPlayerWindows, options = {}) {
  const stages = options.stages || [];
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const q = window.outputRegression, state = q.player.getState();
    return state.playerState === 'PAUSED' && [...document.querySelectorAll('audio')]
      .some(audio => audio.getAttribute('src') === state.audioSrc && audio.paused);
  });
  let paused = await snapshot();
  const modes = options.modes || [...selected, { backend: 'hqplayer', id: 'hqplayer-local', silent: true }, { backend: 'browser', id: '' }];
  for (const mode of modes) {
    await page.evaluate(async mode => {
      const q = window.outputRegression; q.events.length = 0;
      if (mode.backend === 'hqplayer') q.hqp.getState().setSilentLaunch(mode.silent);
      await q.settings.getState().handleSetNativeAudioOutput(mode.backend, mode.id);
    }, mode);
    await page.waitForFunction(({ backend, position }) => {
      const q = window.outputRegression, state = q.player.getState();
      if (q.settings.getState().nativeAudioBackend !== backend || state.playerState !== 'PAUSED' || Math.abs(q.clock.get() - position) >= 1) return false;
      if (backend === 'browser') return [...document.querySelectorAll('audio')]
        .some(audio => audio.getAttribute('src') === state.audioSrc && audio.paused && audio.readyState >= 2 && Math.abs(audio.currentTime - position) < 1);
      return q.events.some(event => event.state?.backend === backend && !event.state.playing && Math.abs(event.state.position - position) < 1
        && (!event.state.streaming || event.state.bufferedEnd > position + .3 || event.state.producerComplete));
    }, { backend: mode.backend, position: paused.position }, { timeout: 75000 });
    const after = await snapshot();
    assert.equal(after.id, paused.id); assert.equal(after.playing, 'PAUSED');
    assert.ok(Math.abs(after.position - paused.position) < 1, 'Paused handoff changed the position');
    assert.deepEqual(after.errors, []); assert.equal(after.browser.length, 0);
    const handoff = { mode: `paused-${mode.backend}`, pass: true, before: paused, after };
    if (observeHQPlayerWindows) {
      handoff.windows = observeHQPlayerWindows();
      if (mode.backend === 'hqplayer') {
        assertHQPlayerWindowVisibility(handoff.windows, true);
      } else if (paused.backend === 'hqplayer') assert.equal(handoff.windows.pids.length, 0, 'Paused output switch did not release HQPlayer');
    }
    stages.push(handoff);

    // Folia's progress bar deliberately resumes a paused song (App.seekMainAudio).
    // The native stream must wait for its replacement prebuffer before that Play.
    await page.evaluate(() => { const q = window.outputRegression; q.events.length = 0; q.browserResumes.length = 0; });
    // Leave room for Chromium's native range thumb, which consumes several
    // pixels even when the custom progress thumb is visually hidden.
    const target = await seekThroughProgressControl(page, 20);
    await page.waitForFunction(({ backend, target }) => {
      const q = window.outputRegression, state = q.player.getState();
      if (state.playerState !== 'PLAYING' || q.clock.get() <= target + 1) return false;
      if (backend === 'browser') return [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === state.audioSrc && !audio.paused && audio.currentTime > target + 1);
      return q.events.some(event => event.state?.backend === backend && event.state.playing && event.state.position > target + 1);
    }, { backend: mode.backend, target }, { timeout: 75000 });
    const resumed = await snapshot(); assert.equal(resumed.id, paused.id); assert.deepEqual(resumed.errors, []);
    const first = await page.evaluate(backend => {
      const q = window.outputRegression;
      return backend === 'browser' ? q.browserResumes.find(event => event.currentSource)?.position
        : q.events.find(event => event.state?.backend === backend && event.state.playing)?.state.position;
    }, mode.backend);
    assert.ok(Number.isFinite(first) && Math.abs(first - target) < 1, 'Progress seek did not resume from the selected checkpoint');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Space');
    // The renderer announces a fade-out pause before the device acknowledgement.
    // Measure stability only once the actual current output has stopped.
    await page.waitForFunction(backend => {
      const q = window.outputRegression, state = q.player.getState();
      if (state.playerState !== 'PAUSED') return false;
      if (backend === 'browser') return [...document.querySelectorAll('audio')]
        .some(audio => audio.getAttribute('src') === state.audioSrc && audio.paused);
      const latest = q.events.filter(event => event.state?.backend === backend).at(-1)?.state;
      return latest && !latest.playing && Math.abs(q.clock.get() - latest.position) < .15;
    }, mode.backend, { timeout: 75000 });
    const held = await snapshot(); await page.waitForTimeout(400); const stable = await snapshot();
    assert.ok(Math.abs(stable.position - held.position) < .15, 'Paused playback clock continued advancing');
    assert.deepEqual(stable.errors, []); assert.equal(stable.id, paused.id);
    stages.push({ mode: `progress-seek-auto-resume-${mode.backend}`, pass: true, target, resumed, firstPlayingPosition: first, paused: stable });
    paused = stable;
  }
  if (options.rapid === false) return stages;
  await page.keyboard.press('Space');
  await page.waitForFunction(position => window.outputRegression.clock.get() > position + 1, paused.position);
  const before = await snapshot();
  await page.evaluate(async selected => {
    const q = window.outputRegression; q.events.length = 0;
    // Immediate consecutive user selections; the final browser selection owns playback.
    await Promise.all([...selected, { backend: 'browser', id: '' }].map(mode =>
      q.settings.getState().handleSetNativeAudioOutput(mode.backend, mode.id)));
  }, modes.filter(mode => mode.backend !== 'browser'));
  await page.waitForFunction(position => {
    const q = window.outputRegression, state = q.player.getState();
    return q.settings.getState().nativeAudioBackend === 'browser' && state.playerState === 'PLAYING'
      && [...document.querySelectorAll('audio')].some(audio => audio.getAttribute('src') === state.audioSrc && !audio.paused && audio.currentTime > position + 1);
  }, before.position, { timeout: 75000 });
  const after = await snapshot();
  assert.equal(after.id, before.id); assert.deepEqual(after.errors, []);
  if (observeHQPlayerWindows) assert.equal(observeHQPlayerWindows().pids.length, 0, 'Rapid output selections left a HQPlayer instance');
  stages.push({ mode: 'rapid-output-changes', pass: true, before, after });
  return stages;
}
