# r36 scoped read-only preparation overlap

Status: implementation frozen. The overlap implementation passed 18/18 focused production-composition tests. The final same-grant refresh correction below passed 16/16 actual-vault lifecycle/read-only checks, 3/3 affected overlap checks, 11/11 existing vault tests and 39/39 independent refresh-race checks on sessionVault SHA256 `80a8d43a20db7b826ec594419f66817f55e6218130ac5f7246dfb8a746a218ba`. Patch and per-file identities are in `results/PROVENANCE.json`. The seven-module patch does not contain the separately owned metadata or route-proof changes. The last correction changes only sessionVault.cjs and is separately available in `same-grant-refresh.patch`.

## Change and authority boundary

A new audio request begins its authenticated track metadata and device inventory GETs while the prior source and any retained route cleanup complete. The metadata and device GETs also overlap each other on first preparation. The entire setup operation does not move: recoverBeforePlay, route trial admission, native discovery/acquire, player baseline/state reads, every control PUT, capture and publication remain after successful old restoration.

Metadata remains uncommitted until restoration and source ownership are checked. Acceptance validates account/vault stamp, metadata generation/market receipt, exact cached-entry identity and original 60-second age. New GET facts are committed with their original response-completion time, using the metadata sibling's `remember(..., {observedAt})` extension. Cancel, newer source intent and a failed old restore cannot publish speculative entries. A failed request also removes facts committed before a later preparation failure, using the existing ownership-aware removal rule.

Device snapshots are opaque WeakMap receipts bound to the exact source session, AbortSignal, controller generation, account stamp and original five-second deadline. Setup additionally binds its configuration generation and selected endpoint fields. A receipt is consumed once by the corresponding controller preparation; another caller or an unrelated ambient setup request cannot replace it. Expiry performs the ordinary fresh GET. An observed clock rollback permanently invalidates that receipt. Speculative inventory is not inserted into the passive 15-second UI cache.

All speculative promises acquire rejection handlers immediately. Cancellation races the read result so an uncooperative metadata producer cannot hold a retired source request open; the first genuine GET error also returns without waiting for a blocked sibling. Late producers remain observed and cannot publish data.

The service supplies the new prefetch hook. Compatibility compositions without the hook, or with an older shared metadata implementation lacking isCurrent, retain the prior serial path. Explicit setup revocation also clears shared metadata.

## Executed checks

Run from this application:

    node --test test/r36-overlap/restore-overlap.test.cjs

Final result: 18 passed, 0 failed, approximately 10.33 seconds. Separate real-vault tests: 6 passed; existing vault suite: 11 passed. The log is `results/focused.log`, with individual HTTP/event/native transcripts beside it.

The tests execute the real production source, setup (including actual saved-settings IO), API/controller, owned audio/lifecycle/host and fixed C# core through NDJSON. The HTTP server simulates Spotify; OS identity/component qualification, endpoint/process inventory, capture and output remain explicit fixture boundaries. No account calls, OAuth, uploads or user-computer operations occurred.

Covered:

- Both reads complete while old restoration is blocked; metadata is still absent, no new lease/select/capture occurs, and the next selection follows exactOriginalRolesRestored.
- An actual C# restoration write failure retains recoveryRequired, rejects preparation, and blocks subsequent track selection.
- Cancel and a newer track revoke the previous snapshots; only the latest track is selected.
- Changed account, market and setup generation cannot admit stale facts.
- A real 5.1-second restoration hold expires the device receipt and causes exactly one replacement GET. The metadata entry retains its pre-restore timestamp and expires at that original timestamp + 60 seconds.
- Metadata/devices 403 errors remain visible during restoration. Late cancelled reads cannot repopulate facts.
- Cancellation after the restore barrier and a real read failure both complete while a test metadata transport ignores AbortSignal.
- Exact receipt ownership, single consumption, isolation from ambient handoffs and permanent rollback invalidation.
- Virtual 24-hour paused hold causes no new HTTP/capture/native activity; paused seek remains paused, and same-track resume preserves the 29,000 ms heard checkpoint without selecting a new song. The shared wall clock is restored before actual C# resume proof, because the fixed C# fixture intentionally uses its own real clock.
- No unhandled rejection escaped the suite.

Initial attempts to jump only the JS clock during active C# restoration/resume produced invalid cross-clock proof timestamps. Those fixture mistakes were corrected by using a real 5.1-second restoration delay and by ending the virtual idle clock jump before active native proof. They were not resolved by weakening production proof checks.

Four existing checked-in Spotify suites were compared once against frozen r35: baseline and initial candidate both produced 47 identical failing test names and 184 passes out of 231. There were no new failure names. These historical assertions include superseded Pause-200 and volume-recovery expectations; they were not changed or used to undo current behavior. JSON comparisons are `results/existing-baseline.json` and `results/existing-candidate.json`.

## Performance interpretation

This change does not delete either required cold metadata/devices GET. It moves them off the critical path where restoration is long enough, and makes them concurrent otherwise. With 450 ms GETs: fresh cold/standalone preparation can save approximately one GET interval (450 ms); switching to an uncached track while old cleanup covers the reads can save approximately two intervals (900 ms); an eligible same-track metadata cache hit can overlap its one device read (450 ms). A device snapshot older than five seconds must be re-read, so the associated saving is intentionally lost. Same-source paused seek, resume and output handoff do not run this new source-preparation prefetch path.

The independent measurement worker completed a frozen 450 ms GET / 650 ms PUT / 350 ms prebuffer composition: warm device/new track 6066 → 5606 ms (7 GET / 4 PUT both); manual Next 7923 → 7000 ms (10 / 5 both); warm same track 7445 → 7002 ms (9 / 5 both); natural-completion transition 8433 → 7527 ms (11 / 5 both). Cold was 7371 → 6164 ms (8 / 4 both), but helper startup varied, so its full 1207 ms difference cannot be attributed to this change. Paused seek/resume, active seek and same-source output handoff retained their call counts and showed noise-only timing differences. Evidence: the sibling measurement/application/test/r36-measurement/r36-composed-timing.json. These measurements precede the safe non-refresh-token amendment below; that amendment leaves long-valid-token GET/PUT topology unchanged and deliberately skips speculation around credential refresh. Do not substitute these upper bounds for those measurements, claim a three-second goal met, or label any cloud/native-boundary timing as Windows hardware timing. The earlier 134 + 121 ms real cloud GET sample is unrelated to the controlled latency evidence.

## Reproduction inputs

The source fixture and native bridge were copied from the measurement worker and retain the fixed native fixture directory under folia-rebuild-r34. The test sets FOLIA_SOURCE_TEST_APP to its local application and uses the existing .NET runtime/native binaries. Their exact hashes and the executed production-module hashes are recorded in each case's JSON transcript. The metadata dependency hashes are in PROVENANCE.json; their source is owned by the metadata sibling, not by this patch.


## Actual session-vault refresh correction

Independent lead review identified that vault.token() is not read-only: at expiry ≤ 60 seconds it can POST a token refresh and increment the vault revision. A real-vault/real-controller/real-native-core reproduction confirmed a new unsafe ordering in the initial four-module patch: a speculative refresh completed while the old restoration GET was outstanding; the old stamp then failed and C# retained recoveryRequired. Frozen r35 restored the old route first, refreshed afterward and prepared successfully. Both traces are preserved as vault-threshold-{before-fix,baseline}.json.

The final patch adds token({allowRefresh:false}) for speculative metadata and every device authorization/request token lookup. It never initiates or joins an actual credential refresh. When refresh is needed or already active, an internal PREPARATION_READ_DEFERRED result discards both snapshots. Only after exact old restoration, while no new route/source writes have occurred, does the source clear its speculative stamp and reauthorize using the original serial path. The source also rechecks this non-refresh window after restoration, so even reads that completed early cannot force a stale grant through a later threshold crossing. The flag distinguishes an actual refresh from ordinary concurrent unexpired token reads; the latter remain parallel.

Real-vault results:

- Threshold crossed while the old restoration GET was outstanding and before speculative scope was admitted: final candidate succeeds; its sole refresh POST occurs only after exact restoration.
- Both speculative GETs completed before the restoration-time threshold crossing: final candidate discards them, restores first, refreshes once and performs fresh preparation reads successfully.
- The first no-refresh amendment still inherited r35's failure when the old owner's own next GET required refresh before dispatch: the credential revision invalidated the old owner and retained recoveryRequired. The subsequent same-grant correction below fixes this distinct inherited defect; the old failing traces remain preserved.
- Unexpired real vault: both GETs finish during the blocked old restoration, zero refresh POSTs, unchanged revision, no new route/select/capture before restoration.
- Six new vault tests cover exact 60-second boundary, no file writes/revision changes, in-flight refresh deferral, normal refresh coalescing, logout invalidation and unexpired read concurrency and invalid stored-expiry rejection. The existing 11 vault tests also pass.

No real credentials or account calls are used: the vault stores generated fake strings in a temporary local directory with fake safeStorage; a bounded fake accounts endpoint returns the generated refresh response. No token values are written to the result traces.

A remaining conservative boundary is intentional for this revision: if the shared metadata receipt itself reaches 60 seconds before acceptance, isCurrent rejects it as SESSION_CHANGED. Only an aged/replaced metadata entry whose receipt is still valid takes the refresh-read branch. The five-second device expiry path does automatically re-read and is directly tested.

## Same-grant refresh after indefinite paused hold

The inherited credential-revision failure affects actual user behavior, not obsolete fixtures. The new `vault-paused-lifecycle.test.cjs` was run against frozen r35 for Play, Stop and registered Quit after a held pause and a 24-hour advance of only the real vault's clock. All three positive invariants failed: Play and Stop returned `Spotify: session-changed`; Quit remained open rather than calling app.quit. See `results/vault-paused-baseline.log` and the three `baseline-grant-refresh-paused-*.json` records. The source/native proof clock remains real, so this test does not weaken or bypass native observation expiry.

The final vault keeps credential `revision` and `writeIntent` for disk and refresh compare-and-swap checks, and exposes a separate authorization `grantRevision` through stamp/grantedScopes. Public save always replaces authorization. Clear revokes generation and authorization. Only the original internal refresh chain, with unchanged clientId and normalized scope and no intervening write, may retain its authorization identity. Changed scope/client, malformed credentials, logout, a replacement grant, refresh failure and disk failure remain genuine failures. Callers cannot request preservation through public save.

The same private refresh stays singleflight through its own disk write; an unrelated writeIntent never qualifies. A scope read interrupted by that exact refresh may wait for the same task and reread once, then verify the original grant and exact committed credential revision/writeIntent. One private commit marker survives later unexpired token reads; it contains only CAS identity/completion evidence, and the task reference is cleared after settlement. Public save synchronously increments writeIntent before enqueueing its write, so the previous marker immediately stops matching; clear also removes the marker. Public/private rename windows with a new scope cannot publish that new scope under the old grant stamp. The speculative token option still neither initiates nor joins refresh and still returns null while the actual refresh is pending.

Final executed evidence, all on the exact vault hash in PROVENANCE:

- `results/vault-grant-final.log`: 16/16 (10 lifecycle/composition checks plus 6 read-only vault checks). Real-vault + C# held-pause Play preserves the 17,000 ms heard checkpoint and creates fresh PCM generation 2; Stop restores the exact original route; the production registered before-quit/service.close path restores before app.quit. Each successful case refreshes once and preserves the same grant stamp. Next-track speculation also succeeds when the old owner requires refresh and cannot select before exact restoration.
- The same suite rejects narrowed scope, logout, a concurrent public grant and an actual session.enc.tmp write-to-directory failure. These cases create no additional PUT or capture, retain recoveryRequired with restoreWritesStarted=false, and never claim exact restoration. Changed scope still blocks registered Quit with its recovery dialog. No unhandled rejection occurred.
- `results/grant-refresh-overlap-regression.log`: 3/3 affected checks, including the real unexpired vault's concurrent GETs during old restoration and unchanged gating.
- `results/vault-existing-grant.log`: existing vault suite 11/11.
- Sibling `review-refresh/verification.json` and `verification.log`: 39/39 independent checks on the same final hash, including malformed/rotated credentials, scope/client changes, public save/logout/write failure, private disk-phase singleflight, the later-unexpired-reader interleaving, and exact public/private rename windows.

Per-case production logs contain `vaultArtifact.sha256` and fail if the file changes during the case. The actual Quit registration uses the real cable service close orchestration with the fixture's real production source/controller/lifecycle injected; Windows capture and the Electron shell remain boundary doubles. No real account, OAuth endpoint, credential storage, audio device or user computer was accessed. The earlier 450/650 timing matrix was not rerun for this authentication correction, and no new timing claim is made.
