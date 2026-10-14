using System.Diagnostics;
using Folia.ProductRoute;
using Folia.RouteObservation.Windows;
using Folia.RouteResearch;
using Folia.RouteResearch.Windows;

namespace Folia.RouteRunner;

// Supplies Windows facts for the separately owned retained-handle recovery
// transaction. This type never opens a journal path, adopts another process,
// changes a global default, or restores policy while pause is unknown.
internal sealed class WindowsProductRecoveryDependencies : IDisposable, ISelectedEndpointVerifier
{
    private readonly SpotifyIdentity identity;
    private readonly IVerifiedSpotifyResolver nativeResolver;
    private readonly ProductSessionObserver observer;
    private readonly SourcePauseVerifier source;
    private readonly OwnedPlaybackTarget playback;
    private readonly BaseRenderEndpoint target;
    private readonly RouteSelection selection;
    private readonly string?[] originals, defaults;
    private readonly OriginalPolicyBinding[] originalDestinations;
    private readonly int[] candidatePids;
    private bool disposed;
    internal IVerifiedSpotifyResolver Resolver { get; }
    internal ISelectedEndpointVerifier EndpointVerifier => this;
    internal ISessionObserver Observer => observer;

    internal WindowsProductRecoveryDependencies(SpotifyProcess expected, BaseRenderEndpoint target,
        RouteSelection selection, string?[] originalRoles, string?[] frozenGlobalDefaults,
        OwnedPlaybackTarget playback, WindowsProductAdmission admission,
        Func<OwnedPlaybackTarget, ISourcePlaybackControl> createSourceControl, OriginalPolicyBinding[]? originalDestinations=null)
    {
        if (!admission.Capabilities.CanOperate) throw new RouteBlockedException("RECOVERY_WINDOWS_ADMISSION_REQUIRED");
        if (playback.Process != expected || selection.RenderDeviceId != target.Id ||
            originalRoles.Length != 3 || frozenGlobalDefaults.Length != 6 ||
            originalRoles.Any(value => value == "") || frozenGlobalDefaults.Any(value => value == ""))
            throw new RouteBlockedException("RECOVERY_BASELINE_INVALID");
        // Recovered dev11: recovery discards an expired preparation/restore scope.
        this.target = target; this.selection = selection; this.playback = playback.ForFreshRecovery();
        originals = originalRoles.ToArray(); defaults = frozenGlobalDefaults.ToArray();
        OriginalPolicySafety.RequireRetained(originalDestinations, originals);
        this.originalDestinations = originalDestinations!.ToArray();
        identity = new SpotifyIdentity(expected.Pid);
        try
        {
            if (identity.Identity != expected) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
            nativeResolver = new Win11SpotifyPolicyResolver(identity.Check);
            observer = new(new WindowsCoreAudioSessionFeed(TimeSpan.FromSeconds(2)), target.Id);
            try
            {
                candidatePids = Candidates(); observer.BindAudioProcessSet(candidatePids);
                source = new(createSourceControl(this.playback), observer.ForPause, nativeResolver);
                Resolver = new WindowsProductBackend.GuardedResolver(nativeResolver, BeforeSet, VerifyEnvironment);
                VerifyEnvironment();
                observer.BindEnvironmentGuard(VerifyEnvironment);
            }
            catch { observer.Dispose(); throw; }
        }
        catch { identity.Dispose(); throw; }
    }
    // Only a fresh exact owned URI/device may be paused. Null/changed/unknown
    // active source throws and leaves retained recovery pending without setters.
    internal void PauseOwnedAndVerify()
    {
        VerifyEnvironment(); source.PauseOwnedForRecovery(playback); VerifyEnvironment();
    }
    internal void VerifyPaused()
    {
        VerifyEnvironment(); source.RequirePaused(playback); VerifyEnvironment();
    }
    internal void VerifyEnvironment()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (identity.Check(identity.Identity.Pid) != playback.Process) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        if (!candidatePids.SequenceEqual(Candidates())) throw new RouteBlockedException("SPOTIFY_CANDIDATE_SET_CHANGED");
        using (var audio = new AudioReadOnly()) OriginalPolicySafety.VerifyRestoration(originalDestinations, originals, audio.Endpoint, PhysicalOriginalEndpointProbe.ReadForRestore);
        using var bound = nativeResolver.OpenVerified(playback.Process);
        if (bound.Get(RenderRole.Communications) != originals[2]) throw new RouteBlockedException("COMMUNICATIONS_POLICY_CHANGED");
    }
    internal ProductDefaultStatus ReadDefaultStatus()
    {
        var current = ProductDefaultEndpoints.Read();
        using var audio = new AudioReadOnly();
        return ProductDefaultEndpoints.Status(defaults, current, audio.Endpoint);
    }
    private void BeforeSet(RenderRole role, string? value)
    {
        if (role is not (RenderRole.Console or RenderRole.Multimedia) || value != originals[(int)role])
            throw new RouteBlockedException("RECOVERY_WRITE_OUTSIDE_EXACT_ORIGINALS");
        VerifyPaused();
    }
    public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected)
    {
        if (expected != target) throw new RouteBlockedException("RECOVERY_TARGET_CHANGED");
        using var audio = new AudioReadOnly();
        var actual = WindowsProductBackend.RequirePair(selection, audio.Endpoints(2));
        if (actual != expected) throw new RouteBlockedException("BASE_PAIR_CHANGED");
        return actual;
    }
    private static int[] Candidates()
    {
        var values = Process.GetProcessesByName("Spotify");
        try { return values.Select(value => value.Id).Order().ToArray(); }
        finally { foreach (var value in values) value.Dispose(); }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        try { observer.Dispose(); } finally { identity.Dispose(); }
    }
}
