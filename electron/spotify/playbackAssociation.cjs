'use strict';
const { randomInt, createHash, randomBytes } = require('node:crypto');
const { REQUIRED_DEVICE_SCOPE } = require('./grantScopes.cjs');

// electron/spotify/playbackAssociation.cjs: paired observations from main-owned readers/control only.
// A successful challenge establishes dynamic playback association, never canonical Soloist identity.
const error = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const position = (value, duration) => Number.isSafeInteger(value) && value >= 0 && value < duration;
const sameStamp = (a, b) => a?.epoch === b?.epoch && a?.revision === b?.revision;
const ownerTag = owner => [owner.pid, owner.startTicks, owner.wsPort, owner.zeroConfPort,
    ...('uid' in owner ? [owner.uid, owner.executableDevice, owner.executableInode, owner.executableSha256] : [])].join(':');
const codes = new Set(['SCOPES_UNKNOWN', 'SCOPE_REQUIRED', 'SESSION_CHANGED', 'STALE_OBSERVATION', 'OWNERSHIP_UNKNOWN',
    'AUTH_REQUIRED', 'DEVICE_INACTIVE', 'DEVICE_ID_UNAVAILABLE', 'DUPLICATE_DEVICE_ID', 'AMBIGUOUS_ACTIVE_DEVICE',
    'DEVICE_NOT_LISTED', 'DEVICE_ID_MISMATCH', 'PROTOCOL_INVALID', 'PAUSED_TEST_REQUIRED', 'TRACK_UNAVAILABLE',
    'POSITION_MISMATCH', 'CHALLENGE_NOT_AUTHORIZED', 'CHALLENGE_UNCONFIRMED', 'RESTORE_UNCONFIRMED',
    'EXTERNAL_INTERACTION', 'TRACK_TOO_SHORT', 'BUSY', 'RATE_LIMITED', 'API_FORBIDDEN', 'API_UNAVAILABLE', 'PLAYBACK_UNAVAILABLE']);
function owned(snapshot) {
    const o = snapshot?.owner;
    // The owned guest adapter obtains these from process/socket ownership, never mDNS display names.
    if (!o || !Number.isSafeInteger(o.pid) || o.pid <= 0 || !/^\d+$/.test(o.startTicks || '')
        || ![o.wsPort, o.zeroConfPort].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535)
        || o.wsSocketPid !== o.pid || o.zeroConfSocketPid !== o.pid
        || o.wsSocketStartTicks !== o.startTicks || o.zeroConfSocketStartTicks !== o.startTicks) throw error('OWNERSHIP_UNKNOWN');
    const auth = snapshot.authState, p = snapshot.playback;
    if (auth?.logged_in !== true) throw error('AUTH_REQUIRED');
    if (auth.is_active !== true) throw error('DEVICE_INACTIVE');
    if (p?.status !== 'paused' || p.speed !== 0) throw error('PAUSED_TEST_REQUIRED');
    if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(p.uri || '') || !Number.isSafeInteger(p.durationMs) || p.durationMs <= 0
        || !position(p.positionMs, p.durationMs)) throw error('TRACK_UNAVAILABLE');
    if (!validId(snapshot.zeroConf?.deviceID)) throw error('DEVICE_ID_UNAVAILABLE');
    if (snapshot.zeroConf.status !== 101 || snapshot.zeroConf.spotifyError !== 0) throw error('PROTOCOL_INVALID');
    return { owner: ownerTag(o), uri: p.uri, positionMs: p.positionMs, durationMs: p.durationMs,
        zeroConfId: snapshot.zeroConf.deviceID };
}
function pair(catalog, soloist, startedAt, now, toleranceMs) {
    if (![catalog?.receivedAt, soloist?.receivedAt].every(at => Number.isFinite(at) && at >= startedAt && at <= now)) throw error('STALE_OBSERVATION');
    const s = owned(soloist), p = catalog.playback, devices = catalog.devices?.devices;
    if (!validId(catalog.user?.id) || !p || !Array.isArray(devices)) throw error('PROTOCOL_INVALID');
    if (!validId(p.device?.id)) throw error('DEVICE_ID_UNAVAILABLE');
    const ids = devices.map(device => device.id).filter(validId);
    if (new Set(ids).size !== ids.length) throw error('DUPLICATE_DEVICE_ID');
    const active = devices.filter(device => device.is_active === true);
    if (active.length !== 1) throw error('AMBIGUOUS_ACTIVE_DEVICE');
    if (!validId(active[0].id)) throw error('DEVICE_ID_UNAVAILABLE');
    if (!devices.some(device => device.id === p.device.id)) throw error('DEVICE_NOT_LISTED');
    if (active[0].id !== p.device.id) throw error('DEVICE_ID_MISMATCH');
    if (p.device.is_active !== true) throw error('DEVICE_INACTIVE');
    if (p.is_playing !== false) throw error('PAUSED_TEST_REQUIRED');
    if (p.item?.type !== 'track' || p.item.uri !== s.uri || !Number.isSafeInteger(p.item.duration_ms)
        || Math.abs(p.item.duration_ms - s.durationMs) > 1000 || !position(p.progress_ms, p.item.duration_ms)) throw error('TRACK_UNAVAILABLE');
    if (Math.abs(p.progress_ms - s.positionMs) > toleranceMs) throw error('POSITION_MISMATCH');
    return { ...s, account: catalog.user.id, device: p.device.id,
        correlation: s.zeroConfId === null ? 'unknown' : s.zeroConfId === p.device.id ? 'same-bytes-unproven' : 'different-id-spaces' };
}
function unchanged(before, after) {
    if (before.owner !== after.owner || before.account !== after.account || before.device !== after.device || before.uri !== after.uri) throw error('EXTERNAL_INTERACTION');
}
function createPlaybackAssociation({ scopeSnapshot, readCatalogFresh, readOwnedSoloistFresh, seekOwnedPaused,
    now = Date.now, choosePosition, onVerified, toleranceMs = 500, maximumObservationMs = 5000, nonceSalt = randomBytes(16) }) {
    if (![scopeSnapshot, readCatalogFresh, readOwnedSoloistFresh, seekOwnedPaused].every(value => typeof value === 'function')
        || !Number.isInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 1000
        || !Number.isInteger(maximumObservationMs) || maximumObservationMs < 1 || maximumObservationMs > 10000) throw error('PROTOCOL_INVALID');
    let running = false, generation = 0;
    const opaque = value => createHash('sha256').update(nonceSalt).update(value).digest('hex');
    async function verify({ authorizePausedChallenge = false } = {}) {
        const result = { canonicalIdentityVerified: false, accountPlaybackAssociation: 'unverified',
            reason: null, restoration: 'not-required', evidence: null };
        if (running) return { ...result, reason: 'BUSY' };
        running = true;
        const expectedGeneration = generation;
        let stamp, baseline, target, attempted = false, restoreAttempted = false;
        function current() {
            if (expectedGeneration !== generation || !sameStamp(stamp, scopeSnapshot())) throw error('SESSION_CHANGED');
        }
        async function readPair() {
            current(); const startedAt = now();
            // Bound the age of completed observations, not SSH/owner construction time.
            const soloist = await readOwnedSoloistFresh({ fresh: true });
            current();
            const catalog = await readCatalogFresh({ fresh: true });
            current();
            const completedAt = now();
            if (![catalog?.receivedAt, soloist?.receivedAt].every(at => Number.isFinite(at)
                && at >= startedAt && at <= completedAt && completedAt - at <= maximumObservationMs)) throw error('STALE_OBSERVATION');
            return pair(catalog, soloist, startedAt, completedAt, toleranceMs);
        }
        try {
            stamp = scopeSnapshot();
            if (!Array.isArray(stamp?.scopes) || !Number.isSafeInteger(stamp.epoch) || !Number.isSafeInteger(stamp.revision)) throw error('SCOPES_UNKNOWN');
            if (!stamp.scopes.includes(REQUIRED_DEVICE_SCOPE)) throw error('SCOPE_REQUIRED');
            baseline = await readPair();
            result.evidence = { deviceTag: opaque(baseline.device), trackTag: opaque(baseline.uri),
                zeroConfCorrelation: baseline.correlation, baselinePausedPositionMs: baseline.positionMs };
            if (!authorizePausedChallenge) throw error('CHALLENGE_NOT_AUTHORIZED');
            const maximum = baseline.durationMs - 2000;
            if (maximum <= 2000) throw error('TRACK_TOO_SHORT');
            const lowCount = Math.max(0, Math.min(maximum, baseline.positionMs - 3001) - 2000 + 1);
            const highStart = Math.max(2000, baseline.positionMs + 3001), highCount = Math.max(0, maximum - highStart + 1);
            if (lowCount + highCount === 0) throw error('TRACK_TOO_SHORT');
            const pick = choosePosition ? null : randomInt(0, lowCount + highCount);
            target = choosePosition ? choosePosition(baseline.positionMs, baseline.durationMs)
                : pick < lowCount ? 2000 + pick : highStart + pick - lowCount;
            if (!position(target, baseline.durationMs) || target < 2000 || target > maximum
                || Math.abs(target - baseline.positionMs) <= 3000) throw error('TRACK_TOO_SHORT');
            current();
            attempted = true;
            await seekOwnedPaused({ owner: baseline.owner, expectedUri: baseline.uri, expectedStatus: 'paused',
                expectedPositionMs: baseline.positionMs, toleranceMs, positionMs: target });
            // An accepted command alone is never evidence: read BOTH independent channels again.
            const challenged = await readPair(); unchanged(baseline, challenged);
            if (Math.abs(challenged.positionMs - target) > toleranceMs) throw error('CHALLENGE_UNCONFIRMED');
            current();
            restoreAttempted = true;
            await seekOwnedPaused({ owner: baseline.owner, expectedUri: baseline.uri, expectedStatus: 'paused',
                expectedPositionMs: challenged.positionMs, toleranceMs, positionMs: baseline.positionMs });
            const restored = await readPair(); unchanged(baseline, restored);
            if (Math.abs(restored.positionMs - baseline.positionMs) > toleranceMs) throw error('RESTORE_UNCONFIRMED');
            result.restoration = 'confirmed';
            result.evidence.challengePositionMs = target;
            result.evidence.restoredPositionMs = restored.positionMs;
            result.evidence.verifiedAt = now();
            result.evidence.scopeEpoch = stamp.epoch;
            result.evidence.scopeRevision = stamp.revision;
            result.evidence.ownerTag = opaque(baseline.owner);
            result.evidence.validUntil = now() + maximumObservationMs;
            result.accountPlaybackAssociation = 'verified-by-fresh-challenge';
            // A private main-process callback retains the proven API target. It is never an IPC result.
            onVerified?.({ deviceId: restored.device, accountId: restored.account, owner: restored.owner,
                uri: restored.uri, stamp: { epoch: stamp.epoch, revision: stamp.revision },
                verifiedAt: result.evidence.verifiedAt, validUntil: result.evidence.validUntil });
        } catch (failure) {
            result.reason = codes.has(failure?.code) ? failure.code : 'PROBE_FAILED';
            if (attempted && result.reason === 'EXTERNAL_INTERACTION') result.restoration = 'skipped-external-interaction';
            else if (attempted && result.restoration !== 'confirmed') {
                // Never undo a user's new URI/play/position or act after grant/daemon revocation.
                try {
                    current(); const startedAt = now(), raw = await readOwnedSoloistFresh({ fresh: true }); current();
                    if (!Number.isFinite(raw?.receivedAt) || raw.receivedAt < startedAt || raw.receivedAt > now()) throw error('STALE_OBSERVATION');
                    const latest = owned(raw);
                    if (latest.owner !== baseline.owner || latest.uri !== baseline.uri) throw error('EXTERNAL_INTERACTION');
                    if (Math.abs(latest.positionMs - baseline.positionMs) <= toleranceMs) result.restoration = 'already-at-original';
                    else if (Math.abs(latest.positionMs - target) <= toleranceMs && !restoreAttempted) {
                        restoreAttempted = true;
                        await seekOwnedPaused({ owner: baseline.owner, expectedUri: baseline.uri, expectedStatus: 'paused',
                            expectedPositionMs: latest.positionMs, toleranceMs, positionMs: baseline.positionMs });
                        const restoreStartedAt = now(), restored = await readOwnedSoloistFresh({ fresh: true }); current();
                        if (!Number.isFinite(restored?.receivedAt) || restored.receivedAt < restoreStartedAt || restored.receivedAt > now()
                            || now() - restored.receivedAt > maximumObservationMs) throw error('STALE_OBSERVATION');
                        const confirmed = owned(restored);
                        if (confirmed.owner !== baseline.owner || confirmed.uri !== baseline.uri || Math.abs(confirmed.positionMs - baseline.positionMs) > toleranceMs) throw error('RESTORE_UNCONFIRMED');
                        result.restoration = 'confirmed-after-failed-probe';
                    } else if (restoreAttempted && Math.abs(latest.positionMs - target) <= toleranceMs) throw error('RESTORE_UNCONFIRMED');
                    else throw error('EXTERNAL_INTERACTION');
                } catch (restoreFailure) { result.restoration = restoreFailure?.code === 'SESSION_CHANGED' ? 'skipped-revoked-session'
                    : ['EXTERNAL_INTERACTION', 'PAUSED_TEST_REQUIRED'].includes(restoreFailure?.code) ? 'skipped-external-interaction' : 'unconfirmed'; }
            }
        } finally { running = false; }
        return result;
    }
    return { verify, clear() { generation++; } };
}
module.exports = { createPlaybackAssociation };
