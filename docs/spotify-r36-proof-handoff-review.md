# r36 source / native proof handoff review

Date: 2026-10-10 UTC. Baseline: r35 `ed26ba93e2cb5e587bfadc92b8239c1ad0d1b49a7b47549d925702935adf202f`.

## Implemented narrow change

`electron/spotify/desktopPlaybackControl.cjs`, `establishColdIdentity`, now runs:

1. Exact-device select, then its actual track/playing/position GET confirmation.
2. Exact-source pause, its actual paused GET, corrective seek when needed, and its actual GET.
3. The existing bounded native identity inspection, now supplied the confirmed parked facts.
4. Existing acquisition and preparation proof, capture/format setup, resume confirmation, active verification, promotion, second active verification, then PCM publication.

Previously step 3 happened between select and pause. A successful inspection while playing has `SourcePaused=false`; `WindowsProductBackend.InspectForAcquire` must then perform discovery again after pause. An inspection performed after the confirmed park may use the existing five-second, same-selection, same-Context paused inspection handoff. This removes an avoidable discovery pass when that handoff remains eligible. No native executable, capability, role setter, or proof gate changed.

This is an information/discovery handoff, not route authority. `Open` still checks the candidate set, process identity, original raw roles, endpoint identity and original physical endpoints. Source-pause proof and fresh pre-set checks still run. The route generation/lease, capture interval, process creation time and active-session proof are still created/verified by their existing owners.

## Why paused discovery is supported by actual native code

The inspected production source is the recovered r34/dev.13 tree under `folia-rebuild-r34/route-lifecycle/native`:

- `OwnedRoute.Observation/CoherentSessionObserver.cs`, `Classify`: only Expired streams and proven system sounds are excluded. Inactive sessions with exact process ownership remain as `RenderSession(..., Active:false)`.
- `OwnedRoute.ProductWindows/WindowsProductBackend.cs`, `SelectAudioProcess`: a unique process with any retained session is eligible; Active is not required. No-session, multiple identities, incomplete observation and mismatched row identity remain errors.
- `Context.Discover`: recertifies the chosen process and rejects an empty session set. It derives `SourcePaused` from absence of active sessions.
- `InspectForAcquire`: reuses only a paused inspection, exact capture/render selection and age no greater than five seconds. The actual Context is retained; `Open` consumes that Context and checks it again.

Linux execution of the existing native test assemblies passed the inactive-session and bounded-reuse tests. This is not evidence that every real Windows Spotify session remains present after an early pause. If the session has never materialized or becomes Expired, the new sequence keeps the existing bounded no-session retry and fails without route acquisition; it does not resume Spotify to manufacture evidence. That remaining Windows behavior is unverified.

## Lifetime, cancellation and failure boundaries

- The cold command receipt is still produced only by an actual state GET. Inspection never refreshes `observedAt`, `observationGeneration`, `mutationEpoch`, or its account stamp.
- It remains valid only for the exact source record, preparation phase/lease, account epoch/revision, track/device, non-revoked controller and settled writes, within the original five seconds.
- If inspection plus native acquisition consumes that lifetime, the existing formal selection path runs again. Saving a discovery scan therefore does not guarantee a wall-clock saving in every run.
- Unknown 200 acknowledgments still require their own operation-specific GET confirmation. An incorrect pause 204 cannot reach inspection. Wrong device/track or changed account cannot reach capture publication.
- A failed or cancelled inspection now normally leaves an already-confirmed paused source. Existing guarded cleanup still observes the exact source and never changes a different URI; uncertain PUTs retain the existing persistent preparation-intent barrier.
- No restore receipt is reused as a new session's authority. Stop, Quit and track changes still restore exact original roles before the next owner. Indefinite Pause and same-track handoff retain only the existing owner, with capture stopped and fresh preparation on resume.

## Already-reused facts: no extra saving to claim

The r35 automatic routed path already reuses:

- Select's actual confirmation as the pre-pause state, within the same mutation epoch.
- Final paused/seek facts across repeated native preparation source reads.
- One bounded restore observation across the two reads of one `restoreOperationId`.
- The prepared state for the first reader and the initial resume precondition, while eligible.

Each dispatch invalidates the previous source observation. `PreparationObservationLedger` requires both a newer observation generation and a newer mutation epoch across baseline → selected. Merely relabelling an old observation would violate that native contract and falsely suggest new evidence. This candidate does not do that.

## Compound select-204 → pause → GET research

One fresh GET after both writes can establish the final exact device/track/paused state. It cannot establish that the first PUT caused that state, or retroactively authorize an earlier pause of a different source. Spotify pause accepts `device_id`, not an atomic expected-track condition.

The executable research counterexample uses the actual production API transport and a hypothetical unshipped caller:

1. A correct select 204 followed by pause and a matching GET satisfies the final-state predicate.
2. A misleading select 204 that leaves a different track playing still allows the hypothetical pause to stop that other track. The final GET rejects, after the side effect.
3. An external track change between select 204 and pause has the same outcome.

Thus batching can retain the PCM publication guard, but removes the current observed-track guard before pause. It is not an equivalent optimization under the current source-control invariant. No compound write path was shipped. All 200 handling remains unchanged. A future combined-command design must explicitly define which device-scoped side effects are authorized, retain the unknown-write barrier until the whole transaction is observed, and test cancellation and failure between every write. A queued local cancellation must never imply that an already-dispatched remote write was undone.

## Concrete next protocol design, not implemented

A no-mutation baseline → selected transition could avoid one GET in two cases: exact current cold transaction already selected and parked at the requested position; or an existing held same-track route resumes at its already-observed position without seek. It cannot eliminate the ordinary new-track select/pause/seek confirmations.

The minimal safe design separates immutable observation identity from preparation authority:

- Observation: actual GET generation/time, actual command epoch, account stamp, device, URI, paused state and position remain unchanged.
- Authority: native session, generation, lease, interval epoch and a one-use preparation transition identify the current transaction.
- Native issues/owns that transition during authorize/resume. Completion may consume the same immutable observation only when it exactly matches the previously accepted baseline and selected target, no command has intervened, the lifetime still holds, and the full native paused-session/process checks pass again.
- Any command dispatch, newer observation, account change, cancellation, lease/interval change, process identity change, failed restore or new preparation invalidates it. Restore remains a separate operation with its own fresh GET.
- Capability negotiation must prevent a new main process from sending this contract to dev.13. Native ledger, broker parser, response validation and cross-language replay tests need to change together. Simply adding a boolean to caller JSON is insufficient.

This design is deliberately not represented as completed implementation or a measured gain.

## Cost accounting and remaining target gap

Under the existing per-write confirmation contract, a warm new track whose confirmed paused position needs correction has the serial chain:

`select PUT → GET → pause PUT → GET → seek PUT → GET → capture/native setup → resume PUT → GET`.

With the controlled GET=450 ms, PUT=650 ms model, those four PUTs and four dependent GETs alone consume 4.400 s. The production-controller trace in the new test also includes one device GET and one fresh baseline GET: 5.300 s total, before metadata, prior-owner restore, native work, actual capture, output setup and prebuffer. This is virtual-clock request accounting, not a Windows timing measurement and not an impossibility theorem about all possible protocols.

A hypothetical combined select/pause postcondition would remove one GET: 3.950 s for that inner chain, with the source-control semantic difference above. Even four 650 ms writes plus a single 450 ms final observation total 3.050 s, before native/capture/output costs. If pause lands exactly at the requested position, the existing code already omits seek; that branch has fewer costs and should be measured separately.

This candidate changes no HTTP count. Its possible saving is one redundant cold N+1 native discovery, while preserving one full paused discovery and every later guard. There is no supported millisecond estimate for that Windows work. The separate metadata/safe-read overlap candidates can reduce other costs; this candidate alone cannot establish a three-second end-to-end claim.

## Verification performed

- 12 new Node tests of production controller/API: successful parked inspection, unknown 200 confirmation, unchanged receipt time/generation, expiry fallback, native failure, absent-session retry, cancellation, account change, wrong pause 204, changed track, native generation mismatch, and exact serial request accounting.
- Three Node research counterexamples for hypothetical compound select/pause, kept outside production code.
- The first eleven new handoff tests run against original r35 produced seven failing candidate-specific sequence/boundary expectations and four passing preserved invariants. These are not seven separate pre-existing product bugs.
- 26 existing production-JS + loopback HTTP tests passed, including four real C# service transaction integrations. Native identity/session/policy/capture and device I/O remain injected boundaries there.
- Existing native assemblies: 105 device-free product-composition tests and 50 coherent-observer tests passed. No Windows/COM/device execution.

Run the new local tests with:

`node --test test/isolated/spotify/coldPausedInspectionHandoff.test.cjs test/isolated/spotify/selectPauseCompoundProofCounterexample.test.cjs`

The baseline comparison accepts `FOLIA_CONTROL_TEST_APP` pointing to the r35 application. The existing lifecycle harness accepts `FOLIA_SOURCE_TEST_APP` pointing to this candidate application. No live Spotify request, OAuth, credential, upload, Site, user-computer operation, renderer rebuild or native binary rebuild was performed.
