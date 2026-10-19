using System.Diagnostics;
using Folia.Capture;
using Folia.ProductRoute;
using Folia.RouteObservation.Windows;
using Folia.RouteObservation;
using Folia.RouteResearch;
using Folia.RouteResearch.Windows;

namespace Folia.RouteRunner;

// Concrete product composition. All mutable native operations stay behind the
// transaction, retained journal acknowledgement and freshly checked pause proof.
internal sealed class WindowsProductBackend : IProductRouteBackend, IDisposable
{
    private readonly IProductJournalChannel channel;
    private readonly Func<OwnedPlaybackTarget, ISourcePlaybackControl> source;
    private readonly WindowsProductAdmission admission;
    private Context? inspected;
    private long inspectedAt;
    private bool active, disposed;
    internal WindowsProductBackend(IProductJournalChannel channel,
        Func<OwnedPlaybackTarget, ISourcePlaybackControl> createSourceControl, WindowsProductAdmission admission)
    { this.channel = channel; source = createSourceControl; this.admission = admission; }
    public ProductCapabilities Capabilities => admission.Capabilities;

    public ProductDiscovery Inspect(RouteSelection selection)
    {
        CheckLive();
        if (active) throw new RouteBlockedException("LEASE_ALREADY_OWNED");
        if (!Capabilities.CanOperate) throw new RouteBlockedException(string.Join(";", Capabilities.Blockers));
        channel.RequireParentAlive();
        inspected?.Dispose(); inspected = null;
        var context = new Context(selection, source, admission);
        try { context.Discover(); channel.RequireParentAlive(); inspected = context; inspectedAt = Stopwatch.GetTimestamp(); return context.Discovery!; }
        catch { context.Dispose(); throw; }
    }

    internal static bool CanReusePausedInspection(ProductDiscovery? found, RouteSelection requested, TimeSpan age) =>
        found is not null && (found.SourcePaused || !found.RequiresNativePauseObservation) && found.Selection == requested && age >= TimeSpan.Zero
        && age <= PreparationObservationLedger.MaximumAge;
    public ProductDiscovery InspectForAcquire(RouteSelection selection)
    {
        CheckLive();
        if (active) throw new RouteBlockedException("LEASE_ALREADY_OWNED");
        // The actual existing Context is retained. Open still rechecks current
        // process set, endpoint identity and exact originals, and source pause is
        // independently proved before Prepared/setters. No stale session proof
        // or readiness is granted by this bounded discovery reuse.
        return CanReusePausedInspection(inspected?.Discovery, selection, Stopwatch.GetElapsedTime(inspectedAt))
            ? inspected!.Discovery! : Inspect(selection);
    }

    public IProductRouteLifetime Open(ProductDiscovery discovery)
    {
        CheckLive();
        if (active) throw new RouteBlockedException("LEASE_ALREADY_OWNED");
        var context = inspected ?? throw new RouteBlockedException("FRESH_PRODUCT_INSPECTION_REQUIRED");
        if (!ReferenceEquals(discovery, context.Discovery)) throw new RouteBlockedException("PRODUCT_DISCOVERY_RECEIPT_MISMATCH");
        channel.RequireParentAlive(); context.RequireUnchangedInspection();
        var journal = new A025ProductJournalLifetime(discovery, context.Resolver!, context,
            new CurrentObserver(context), context.VerifyPaused, context.VerifyRestorationEnvironment, channel, context.FrozenDefaults,
            context.ReadDefaultStatus, originalDestinations: context.OriginalBindings);
        active = true; inspected = null;
        return new Lifetime(journal, context, () => active = false);
    }
    private void CheckLive() => ObjectDisposedException.ThrowIf(disposed, this);
    public void Dispose() { if (disposed) return; disposed = true; inspected?.Dispose(); inspected = null; }

    // Pure admission decisions are tested without Windows or mock-native flags.
    internal static BaseRenderEndpoint RequirePair(RouteSelection selection, EndpointInfo[] endpoints)
    {
        if (string.IsNullOrWhiteSpace(selection.CaptureDeviceId) || string.IsNullOrWhiteSpace(selection.RenderDeviceId) ||
            selection.CaptureDeviceId == selection.RenderDeviceId) throw new RouteBlockedException("EXACT_BASE_PAIR_REQUIRED");
        var target = AudioReadOnly.SelectVerified(selection.RenderDeviceId, endpoints);
        var capture = endpoints.Where(x => x.Id == selection.CaptureDeviceId).ToArray();
        if (capture.Length != 1 || capture[0].Flow != 1 || capture[0].State != 1 ||
            capture[0].BaseIdentity.State != "verified" ||
            !string.Equals(capture[0].BaseIdentity.OwnerInstanceId, target.PnpOwnerIdentity, StringComparison.OrdinalIgnoreCase))
            throw new RouteBlockedException("EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH");
        return target;
    }
    internal static SpotifyProcess SelectAudioProcess(IReadOnlyList<SessionObservation> observations)
    {
        if (observations.Any(x => !x.CompleteForProcess || !x.Process.WellFormed ||
            x.Sessions.Any(row => row.Process != x.Process || string.IsNullOrWhiteSpace(row.SessionInstanceId))))
            throw new RouteBlockedException("COMPLETE_SPOTIFY_DISCOVERY_REQUIRED");
        var audibleIdentities = observations.Where(x => x.Sessions.Length != 0).Select(x => x.Process).Distinct().ToArray();
        if (audibleIdentities.Length == 0) throw new RouteBlockedException("EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN");
        if (audibleIdentities.Length != 1) throw new RouteBlockedException("SPOTIFY_AUDIO_PROCESS_AMBIGUOUS");
        return audibleIdentities[0];
    }
    private static int[] CandidatePids()
    {
        var values = Process.GetProcessesByName("Spotify");
        try
        {
            if (values.Length > 64) throw new RouteBlockedException("SPOTIFY_DISCOVERY_LIMIT");
            return values.Select(value => value.Id).Order().ToArray();
        }
        finally { foreach (var value in values) value.Dispose(); }
    }

    private sealed class Context : ISelectedEndpointVerifier, IDisposable
    {
        private static readonly TimeSpan DiscoveryBudget = TimeSpan.FromSeconds(3);
        private bool emptyRestoreProof;
        private readonly RouteSelection selection;
        private readonly Func<OwnedPlaybackTarget, ISourcePlaybackControl> source;
        private readonly WindowsProductAdmission admission;
        private readonly List<SpotifyIdentity> candidates = [];
        private int[] candidatePids = [];
        private SpotifyIdentity? selected;
        private IVerifiedSpotifyResolver? nativeResolver;
        private string?[] defaults = [], originals = [];
        private OriginalPolicyBinding[]? originalBindings;
        private OwnedPlaybackTarget? playback;
        private readonly PreparationObservationLedger preparationObservations = new();
        private bool observerSuspended;
        private int intervalGeneration;
        private string? intervalId;
        private bool disposed;
        private OwnedSilentRenderLeaseVerifier? silentLease;
        private OwnedSeekParkReceipt? parkedSeek;
        private bool seekRebindPending;
        internal void BindOwnedSilentRenderLease(OwnedSilentRenderLeaseProof proof)
        {
            if (seekRebindPending)
            {
                if (silentLease is null || intervalGeneration != 0 || parkedSeek is null) throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
                parkedSeek.Validate(parkedSeek.Session, parkedSeek.Generation, parkedSeek.SeekTransaction, DateTimeOffset.UtcNow);
                var previous = silentLease.Proof;
                silentLease.RebindGeneration(proof);
                preparationObservations.AuthorizeSeekKeeperRebind(parkedSeek, previous, proof, DateTimeOffset.UtcNow);
                seekRebindPending = false; parkedSeek = null;
                return;
            }
            if (silentLease is not null || intervalGeneration != 0 || proof.EndpointId != selection.RenderDeviceId)
                throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_INVALID");
            var verified = OwnedSilentRenderLeaseVerifier.Bind(proof);
            try { Observer.BindOwnedSilentRenderSession(verified.Session, () => verified.Live); silentLease = verified; }
            catch { verified.Dispose(); throw; }
        }
        internal void RequireSilentLeaseLive() { if (!observerSuspended) silentLease?.RequireLive(); }
        internal void SuspendCaptureInterval()
        {
            if (observerSuspended || (intervalGeneration != 0 && silentLease is null))
                throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
            // A failed pre-start arm can bind the keeper before interval creation.
            // The fresh stopped-source proof below also retires that partial binding.
            // VerifyPaused just published a complete scan while the main bridge
            // attested capture Stop completion. An active old keeper fails closed.
            // Process capture uses the exact stopped-capture receipt instead;
            // its last endpoint inventory can predate Stop and cannot veto it.
            if (!ProcessCaptureRouting.Enabled && silentLease is not null && Observer.LastCertifiedInventory.Any(row => silentLease.Session.SameInstance(row)
                && row.State == Folia.RouteObservation.AudioSessionState.Active))
                throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_NOT_STOPPED");
            observerSuspended = true;
            Observer.StopForHeldPause();
            intervalGeneration = 0; intervalId = null;
            silentLease?.Dispose(); silentLease = null;
        }
        internal void CancelSeekCaptureInterval()
        {
            if (!ProcessCaptureRouting.Enabled && silentLease is not null && Observer.LastCertifiedInventory.Any(row => silentLease.Session.SameInstance(row)
                && row.State == Folia.RouteObservation.AudioSessionState.Active))
                throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_NOT_STOPPED");
            Observer.StopForHeldPause(); observerSuspended = true; intervalGeneration = 0; intervalId = null;
            silentLease?.Dispose(); silentLease = null; parkedSeek = null; seekRebindPending = false;
        }
        internal void RestartSeekSourcePreparation()
        {
            if (!seekRebindPending || parkedSeek is null) throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
            preparationObservations.BeginResumePreparation();
        }
        internal void ParkSeekCaptureInterval(OwnedSeekParkReceipt receipt)
        {
            if (observerSuspended || intervalGeneration == 0 || silentLease is null || parkedSeek is not null)
                throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
            receipt.Validate(silentLease.Proof.CaptureSession, silentLease.Proof.CaptureGeneration, receipt.SeekTransaction, DateTimeOffset.UtcNow);
            silentLease.RequireLive();
            if (!Observer.IntervalIsolated || Observer.LastCertifiedInventory.Count(silentLease.Session.Matches) != 1)
                throw new RouteBlockedException("SEEK_PARK_KEEPER_CHANGED");
            Observer.StopForHeldPause(); observerSuspended = true;
            intervalGeneration = 0; intervalId = null; parkedSeek = receipt;
        }
        internal void BeginSeekResumePreparation(OwnedSeekParkReceipt receipt, string? transferId, string? intentId)
        {
            if (parkedSeek != receipt || silentLease is null || intervalGeneration != 0 || intervalId is not null || seekRebindPending)
                throw new RouteBlockedException("SEEK_PARK_STATE_INVALID");
            receipt.Validate(silentLease.Proof.CaptureSession, silentLease.Proof.CaptureGeneration, receipt.SeekTransaction, DateTimeOffset.UtcNow);
            silentLease.RequireLive(); EnsureObserver(); seekRebindPending = true;
            if (transferId is null) preparationObservations.BeginResumePreparation();
            else preparationObservations.BeginResumePreparation(transferId, intentId!);
        }
        private void EnsureObserver()
        {
            if (!observerSuspended) return;
            Observer.RequireStopped();
            var next = new ProductSessionObserver(new WindowsCoreAudioSessionFeed(TimeSpan.FromSeconds(2)), selection.RenderDeviceId, new ObservationOptions { QuietPeriod = TimeSpan.FromMilliseconds(10) });
            next.BindAudioProcessSet(candidatePids);
            next.BindEnvironmentGuard(VerifyDefaultsAndCommunications, VerifyRestorationEnvironment);
            if (silentLease is not null && parkedSeek is not null) next.BindOwnedSilentRenderSession(silentLease.Session, () => silentLease.Live);
            Observer = next; observerSuspended = false;
        }
        internal bool IssuePausedProofTransfer(string id, OwnedPlaybackTarget target, DateTimeOffset now)
            => preparationObservations.IssuePausedProofTransfer(id, target, now);
        internal void FinishPausedProofTransfer() => preparationObservations.FinishPausedProofTransfer();
        internal void BeginResumePreparation(string id, string intent)
        {
            if (intervalGeneration != 0 || intervalId is not null || silentLease is not null)
                throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
            EnsureObserver(); preparationObservations.BeginResumePreparation(id, intent);
        }
        internal void BeginResumePreparation()
        {
            if (intervalGeneration != 0 || intervalId is not null || silentLease is not null)
                throw new RouteBlockedException("PAUSED_ROUTE_STATE_INVALID");
            EnsureObserver(); preparationObservations.BeginResumePreparation();
        }
        internal ProductDiscovery? Discovery { get; private set; }
        internal IVerifiedSpotifyResolver? Resolver { get; private set; }
        internal ProductSessionObserver Observer { get; private set; }
        internal string?[] FrozenDefaults => defaults.ToArray();
        internal OriginalPolicyBinding[] OriginalBindings => originalBindings?.ToArray() ?? throw new RouteBlockedException("ORIGINAL_POLICY_PROOF_REQUIRED");
        internal int IntervalGeneration => intervalGeneration;
        internal string? IntervalId => intervalId;
        internal void ArmCaptureInterval(string session, int generation)
        {
            if (string.IsNullOrWhiteSpace(session) || generation <= 0 || intervalGeneration != 0 ||
                Discovery is null || playback?.Process != Discovery.Identity)
                throw new RouteBlockedException("CAPTURE_INTERVAL_SOURCE_BINDING_REQUIRED");
            RequireCandidateSet(); VerifyDefaultsAndCommunications();
            Observer.BeginIsolation(Discovery.Identity);
            intervalGeneration = generation;
            intervalId = Guid.NewGuid().ToString("D");
        }
        internal Context(RouteSelection selection, Func<OwnedPlaybackTarget, ISourcePlaybackControl> source,
            WindowsProductAdmission admission)
        {
            this.selection = selection; this.source = source; this.admission = admission;
            Observer = new(new WindowsCoreAudioSessionFeed(TimeSpan.FromSeconds(2)), selection.RenderDeviceId, new ObservationOptions { QuietPeriod = TimeSpan.FromMilliseconds(10) });
        }
        internal void Discover()
        {
            using var coldTiming=ColdTiming.Scope("route.Discover");
            var timer = Stopwatch.StartNew();
            BaseRenderEndpoint target;
            using (var audio = new AudioReadOnly()) target = RequirePair(selection, audio.Endpoints(2));
            defaults = ProductDefaultEndpoints.Read();
            if (!ProcessCaptureRouting.Enabled && defaults.Take(2).Any(value => value is null || value == target.Id))
                throw new RouteBlockedException("NON_BASE_DEFAULT_OUTPUT_REQUIRED");
            using (var audio = new AudioReadOnly())
                foreach (var id in ProcessCaptureRouting.Enabled ? [] : defaults.Take(2).Distinct())
                {
                    var endpoint = audio.Endpoint(id!);
                    if (endpoint.State != 1 || endpoint.Flow != 0 || endpoint.BaseIdentity.State != "unsupported")
                        throw new RouteBlockedException("ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN");
                }
            candidatePids = CandidatePids();
            foreach (var pid in candidatePids)
            {
                // Candidate names choose work to verify; they never prove identity.
                using var candidateTiming=ColdTiming.Scope("route.Candidate");
                var identity = new SpotifyIdentity(pid); candidates.Add(identity);
            }
            if (candidates.Count == 0) throw new RouteBlockedException("EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN");
            var remaining = DiscoveryBudget - timer.Elapsed;
            if (remaining <= TimeSpan.Zero) throw new RouteBlockedException("SPOTIFY_DISCOVERY_TIMEOUT");
            using var first = new IdentityOnlyBound(candidates[0]);
            // The first process is only an inventory anchor and may be a Spotify
            // UI/helper process. Classify the audio owner before testing whether
            // a Base writer belongs to it; the chosen process is checked below.
            var publication = Observer.ForPause.Observe(first, remaining);
            Observer.RequireCurrentDiscovery(publication);
            var inventory = Observer.LastCertifiedInventory;
            var observations = new List<SessionObservation>();
            foreach (var candidate in candidates)
            {
                var identity = candidate.Check(candidate.Identity.Pid);
                var rows = inventory.Where(row => row.State != AudioSessionState.Expired && row.SystemSoundsHResult == 1
                    && row.ProcessIdHResult == 0 && row.ReportedProcessId == identity.Pid)
                    .Select(row => new RenderSession(identity, row.SessionInstanceId, row.EndpointId, row.State == AudioSessionState.Active)).ToArray();
                observations.Add(publication with { Process = identity, Sessions = rows });
            }
            Observer.RequireCurrentDiscovery(publication);
            var process = SelectAudioProcess(observations);
            selected = candidates.Single(x => x.Identity == process);
            Observer.BindAudioProcessSet(candidatePids);
            nativeResolver = new Win11SpotifyPolicyResolver(selected.Check);
            Resolver = new GuardedResolver(nativeResolver, BeforeSet, VerifyRestorationEnvironment, ImmediatelyBeforeSet);
            using (var bound = nativeResolver.OpenVerified(process))
                originals = Enum.GetValues<RenderRole>().Select(bound.Get).ToArray();
            originalBindings = VerifyOriginalPolicies(target);
            Observer.BindEnvironmentGuard(VerifyDefaultsAndCommunications, VerifyRestorationEnvironment);
            RequireCandidateSet(); VerifyDefaultsAndCommunications();
            // Recertify the chosen process last. The resulting all-endpoint fence
            // also establishes no other active Base writer at this observation.
            using var chosen = new IdentityOnlyBound(selected);
            var fresh = Observer.Observe(chosen, TimeSpan.FromSeconds(2));
            RequireComplete(fresh, process);
            if (fresh.Sessions.Length == 0) throw new RouteBlockedException("EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN");
            Discovery = new(process, target, selection, originals.ToArray(), !fresh.Sessions.Any(row => row.Active),
                originals.Take(2).All(value => value is null), true, ReadDefaultStatus().Unchanged, true, OriginalPolicySafe: true)
                { RequiresNativePauseObservation = !ProcessCaptureRouting.Enabled };
        }
        internal void RequireUnchangedInspection()
        {
            using var detailTiming = ColdTiming.Scope("route.RequireUnchangedInspection");
            if (Discovery is null || !Discovery.OriginalValues.SequenceEqual(originals))
                throw new RouteBlockedException("PRODUCT_DISCOVERY_CHANGED");
            RequireCandidateSet(); VerifyDefaultsAndCommunications();
            if (VerifySelected(Discovery.Target) != Discovery.Target) throw new RouteBlockedException("BASE_PAIR_CHANGED");
            using var bound = nativeResolver!.OpenVerified(Discovery.Identity);
            if (!Enum.GetValues<RenderRole>().Select(bound.Get).SequenceEqual(originals))
                throw new RouteBlockedException("INSPECTED_ORIGINALS_CHANGED");
            _ = VerifyOriginalPolicies(Discovery.Target);
        }
        private OriginalPolicyBinding[] VerifyOriginalPolicies(BaseRenderEndpoint target)
        {
            using var detailTiming = ColdTiming.Scope("route.VerifyOriginalPolicies");
            using var audio = new AudioReadOnly();
            return OriginalPolicySafety.Verify(originals, target, ProductDefaultEndpoints.Read(), audio.Endpoints(),
                audio.EndpointForPolicy, PhysicalOriginalEndpointProbe.Read, originalBindings,
                allowDefaultFollow: ProcessCaptureRouting.Enabled);
        }
        internal void VerifyPaused(OwnedPlaybackTarget expected)
        {
            using var detailTiming = ColdTiming.Scope("route.VerifyPaused");
            emptyRestoreProof = false;
            if (selected is null || expected.Process != selected.Identity)
                throw new RouteBlockedException("SOURCE_PROCESS_BINDING_MISMATCH");
            RequireCandidateSet();
            EnsureObserver();
            var sourceProof = new SourcePauseVerifier(source(expected),
                expected.AllowEmptyPlayerForRestore ? Observer.ForEmptyRestore
                    : !expected.RequirePausedHoldObservation && (expected.RequirePreparedSelection || expected.RequirePreparationObservation) ? Observer : Observer.ForPause,
                nativeResolver!, preparationLedger: preparationObservations,
                requireNativeQuiescence: !ProcessCaptureRouting.Enabled,
                observeCaptureBaseline: !expected.RequirePcmStopped || expected.RequireSeekParkEvidence).RequirePaused(expected);
            if (expected.RequirePcmStopped) VerifyRestorationBindings();
            VerifyRestorationEnvironment();
            playback = expected;
            emptyRestoreProof = sourceProof.EmptyPlayer;
        }
        private void VerifyRestorationBindings()
        {
            using var audio = new AudioReadOnly();
            OriginalPolicySafety.VerifyRestoration(OriginalBindings, originals, audio.Endpoint, PhysicalOriginalEndpointProbe.ReadForRestore);
        }
        private void BeforeSet(RenderRole role, string? value)
        {
            if (role is not (RenderRole.Console or RenderRole.Multimedia)) throw new RouteBlockedException("ROLE_OUTSIDE_PRODUCT_SCOPE");
            var expected = playback ?? throw new RouteBlockedException("FRESH_SOURCE_PAUSE_PROOF_REQUIRED");
            var applying = value == Discovery!.Target.PolicyValue;
            if (applying && expected.AllowEmptyPlayerForRestore)
                throw new RouteBlockedException("EMPTY_PLAYER_RESTORE_SCOPE_INVALID");
            if (value != Discovery.Target.PolicyValue && value != originals[(int)role])
                throw new RouteBlockedException("POLICY_WRITE_OUTSIDE_OWNED_SCOPE");
            VerifyPaused(applying || expected.RestoreOperationId is not null ? expected : expected.ForFreshRecovery());
            if (applying)
            {
                VerifyDefaultsAndCommunications();
                _ = VerifyOriginalPolicies(Discovery.Target);
                if (!Observer.CurrentCaptureEligible) throw new RouteBlockedException("BASE_OTHER_WRITER_PRESENT");
                if (VerifySelected(Discovery.Target) != Discovery.Target) throw new RouteBlockedException("BASE_PAIR_CHANGED");
            }
        }
        private void ImmediatelyBeforeSet(IBoundSpotifyPolicy bound, RenderRole role, string? value)
        {
            if (!emptyRestoreProof) return;
            if (playback?.AllowEmptyPlayerForRestore != true || playback.RestoreOperationId is null
                || role is not (RenderRole.Console or RenderRole.Multimedia) || value != originals[(int)role]
                || bound.CheckLiveIdentity() != Discovery!.Identity || bound.Get(role) != Discovery.Target.PolicyValue
                || bound.CheckLiveIdentity() != Discovery.Identity)
                throw new RouteBlockedException("EXTERNAL_POLICY_CONFLICT");
            // Recheck after source readback and destination/policy checks. A late
            // native callback during those checks cannot authorize this setter.
            Observer.RequireCurrentRestoreQuiescence();
        }
        internal void VerifyDefaultsAndCommunications()
        {
            using var detailTiming = ColdTiming.Scope("route.VerifyDefaultsAndCommunications");
            var current = ProductDefaultEndpoints.ReadRenderPair();
            if (!ProcessCaptureRouting.Enabled)
                using (var audio = new AudioReadOnly(readInterfaces:false)) ProductDefaultEndpoints.RequireSafeRenderPair(current, audio.EndpointIdentity);
            VerifyRestorationEnvironment();
        }
        internal void VerifyRestorationEnvironment()
        {
            using var detailTiming = ColdTiming.Scope("route.VerifyRestorationEnvironment");
            // Exact owned compensation does not choose or rewrite the global
            // default. Main separately verifies PCM stop before compensation;
            // this worker independently proves the exact source is paused.
            if (nativeResolver is null || selected is null) return;
            using var bound = nativeResolver.OpenVerified(selected.Identity);
            if (bound.Get(RenderRole.Communications) != originals[2]) throw new RouteBlockedException("COMMUNICATIONS_POLICY_CHANGED");
        }
        internal ProductDefaultStatus ReadDefaultStatus()
        {
            var current = ProductDefaultEndpoints.Read();
            using var audio = new AudioReadOnly();
            return ProductDefaultEndpoints.Status(defaults, current, audio.Endpoint);
        }
        public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected)
        {
            using var detailTiming = ColdTiming.Scope("route.VerifySelected");
            using var audio = new AudioReadOnly();
            var actual = RequirePair(selection, audio.Endpoints(2));
            if (actual != expected) throw new RouteBlockedException("BASE_PAIR_CHANGED");
            return actual;
        }
        private void RequireCandidateSet()
        {
            using var detailTiming = ColdTiming.Scope("route.RequireCandidateSet");
            var current = CandidatePids();
            if (!candidatePids.SequenceEqual(current)) RefreshCandidateSet(current);
            foreach (var candidate in candidates) candidate.Check(candidate.Identity.Pid);
        }
        // Spotify may start/retire non-audio helpers after the first playback.
        // Re-certify the inventory without rebinding the owned audio process or originals.
        private void RefreshCandidateSet(int[] current)
        {
            if (Discovery is null || selected is null || nativeResolver is null)
                throw new RouteBlockedException("SPOTIFY_CANDIDATE_SET_CHANGED");
            if (selected.Check(selected.Identity.Pid) != Discovery.Identity || !current.Contains(selected.Identity.Pid))
                throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
            var next = new List<SpotifyIdentity>();
            var created = new List<SpotifyIdentity>();
            var committed = false;
            try
            {
                foreach (var pid in current)
                {
                    var known = candidates.FirstOrDefault(value => value.Identity.Pid == pid);
                    if (known is null) { known = new SpotifyIdentity(pid); created.Add(known); }
                    known.Check(pid); next.Add(known);
                }
                EnsureObserver();
                Observer.BindAudioProcessSet(current);
                using var bound = nativeResolver.OpenVerified(Discovery.Identity);
                var publication = Observer.ForPause.Observe(bound, TimeSpan.FromSeconds(2));
                RequireComplete(publication, Discovery.Identity);
                Observer.RequireCurrentDiscovery(publication);
                if (!current.SequenceEqual(CandidatePids())) throw new RouteBlockedException("SPOTIFY_CANDIDATE_SET_CHANGED");
                foreach (var candidate in next) candidate.Check(candidate.Identity.Pid);
                foreach (var retired in candidates.Except(next)) retired.Dispose();
                candidates.Clear(); candidates.AddRange(next); candidatePids = current; committed = true;
            }
            finally
            {
                if (!committed) { Observer.BindAudioProcessSet(candidatePids); foreach (var candidate in created) candidate.Dispose(); }
            }
        }
        private static void RequireComplete(SessionObservation value, SpotifyProcess process)
        {
            if (!value.CompleteForProcess || value.Process != process || value.Sessions.Any(row => row.Process != process))
                throw new RouteBlockedException("COMPLETE_SPOTIFY_DISCOVERY_REQUIRED");
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            try { Observer.Dispose(); } finally { try { silentLease?.Dispose(); } finally { foreach (var candidate in candidates) candidate.Dispose(); candidates.Clear(); } }
        }
    }
    // Stable forwarding identity keeps the retained journal/transaction bound to
    // the same Context while paused feeds are disposed and freshly recreated.
    private sealed class CurrentObserver(Context context) : ISessionObserver
    {
        public SessionObservation Observe(IBoundSpotifyPolicy process, TimeSpan maximumWait) => context.Observer.Observe(process, maximumWait);
    }
    private sealed class IdentityOnlyBound(SpotifyIdentity identity) : IBoundSpotifyPolicy
    {
        public SpotifyProcess Identity => identity.Identity;
        public SpotifyProcess CheckLiveIdentity() => identity.Check(identity.Identity.Pid);
        public string? Get(RenderRole role) => throw new InvalidOperationException("DISCOVERY_POLICY_ACCESS_FORBIDDEN");
        public void Set(RenderRole role, string? value) => throw new InvalidOperationException("DISCOVERY_POLICY_ACCESS_FORBIDDEN");
        public void Dispose() { }
    }
    internal sealed class GuardedResolver(IVerifiedSpotifyResolver inner, Action<RenderRole, string?> beforeSet,
        Action afterSet, Action<IBoundSpotifyPolicy, RenderRole, string?>? immediatelyBeforeSet = null) : IVerifiedSpotifyResolver
    {
        public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected) => new Bound(inner.OpenVerified(expected), beforeSet, afterSet, immediatelyBeforeSet);
        private sealed class Bound(IBoundSpotifyPolicy inner, Action<RenderRole, string?> before, Action after,
            Action<IBoundSpotifyPolicy, RenderRole, string?>? immediatelyBefore) : IBoundSpotifyPolicy
        {
            public SpotifyProcess Identity => inner.Identity;
            public SpotifyProcess CheckLiveIdentity() => inner.CheckLiveIdentity();
            public string? Get(RenderRole role) => inner.Get(role);
            public void Set(RenderRole role, string? value)
            { before(role, value); immediatelyBefore?.Invoke(inner, role, value); inner.Set(role, value); after(); }
            public void Dispose() => inner.Dispose();
        }
    }
    private sealed class Lifetime(IProductRouteLifetime inner, Context context, Action released) : IProductRouteLifetime
    {
        private bool disposed;
        public IVerifiedSpotifyResolver Resolver => inner.Resolver;
        public ISelectedEndpointVerifier EndpointVerifier => inner.EndpointVerifier;
        public ISessionObserver Observer => inner.Observer;
        public bool RequiresTargetEndpointActivity => !ProcessCaptureRouting.Enabled;
        public IDurableRouteJournal Journal => inner.Journal;
        public bool IntervalIsolated => context.IntervalGeneration != 0 && context.Observer.IntervalIsolated;
        public int IntervalGeneration => context.IntervalGeneration;
        public string? IntervalId => context.IntervalId;
        public void BindOwnedSilentRenderLease(OwnedSilentRenderLeaseProof proof) => context.BindOwnedSilentRenderLease(proof);
        public void ArmCaptureInterval(string session, int generation) => context.ArmCaptureInterval(session, generation);
        public void ValidatePausedOwnerLiveness() => inner.ValidateApplyAuthority();
        public void SuspendCaptureInterval() => context.SuspendCaptureInterval();
        public void CancelSeekCaptureInterval() => context.CancelSeekCaptureInterval();
        public void RestartSeekSourcePreparation() => context.RestartSeekSourcePreparation();
        public void ParkSeekCaptureInterval(OwnedSeekParkReceipt receipt) => context.ParkSeekCaptureInterval(receipt);
        public void BeginSeekResumePreparation(OwnedSeekParkReceipt receipt, string? transferId, string? intentId) => context.BeginSeekResumePreparation(receipt, transferId, intentId);
        public bool IssuePausedProofTransfer(string id, OwnedPlaybackTarget target, DateTimeOffset now) => context.IssuePausedProofTransfer(id, target, now);
        public void BeginResumePreparation(string id, string intent) => context.BeginResumePreparation(id, intent);
        public void FinishPausedProofTransfer() => context.FinishPausedProofTransfer();
        public void BeginResumePreparation() => context.BeginResumePreparation();
        public ProductDefaultStatus ReadDefaultStatus() => inner.ReadDefaultStatus();
        public void BindLease(string session, int generation, string leaseId) => inner.BindLease(session, generation, leaseId);
        public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord value) => inner.RetainAndAcknowledgePrepared(value);
        public void ValidateOwnership(PreparedRetention value) => inner.ValidateOwnership(value);
        public void ValidateApplyAuthority()
        {
            inner.ValidateApplyAuthority();
            context.RequireSilentLeaseLive();
            context.VerifyDefaultsAndCommunications();
        }
        public void VerifyPausedSource(OwnedPlaybackTarget value) => inner.VerifyPausedSource(value);
        public void VerifyRestoredTerminal(RouteRecord value, PreparedRetention receipt) => inner.VerifyRestoredTerminal(value, receipt);
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            try { inner.Dispose(); } finally { try { context.Dispose(); } finally { released(); } }
        }
    }
}
