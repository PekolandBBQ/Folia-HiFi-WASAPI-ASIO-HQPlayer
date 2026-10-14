using Folia.RouteResearch.Native;

namespace Folia.RouteResearch.Windows;

// Bridge for runtime-selected Windows 10/11 interfaces. The name is retained for source compatibility.
// The host independently verifies process identity, endpoints and real session observations.
public sealed class Win11SpotifyPolicyResolver(Func<int, SpotifyProcess> verifyCurrentSpotify,
    Action<string, RenderRole, int>? observeHresult = null, Action? beforeSet=null) : IVerifiedSpotifyResolver
{
    public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected) =>
        new Bound(expected, verifyCurrentSpotify, observeHresult,beforeSet);

    private sealed class Bound : IBoundSpotifyPolicy
    {
        private readonly BoundWin11AppRoute native;
        private readonly Action<string, RenderRole, int>? observeHresult;
        private readonly Action? beforeSet;
        public SpotifyProcess Identity { get; }
        public Bound(SpotifyProcess expected, Func<int, SpotifyProcess> verify,
            Action<string, RenderRole, int>? observe, Action? before)
        {
            Identity = expected;
            observeHresult = observe; beforeSet=before;
            native = new BoundWin11AppRoute(ToNative(expected), pid => ToNative(verify(checked((int)pid))));
        }
        public SpotifyProcess CheckLiveIdentity()
        {
            try { native.CheckIdentity(); return Identity; }
            catch (InvalidOperationException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
            { throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED"); }
        }
        public string? Get(RenderRole role)
        {
            var result = native.Get((int)role);
            observeHresult?.Invoke("get", role, result.HResult);
            return result.Value;
        }
        public void Set(RenderRole role, string? endpoint)
        {
            beforeSet?.Invoke();
            var result = native.Set((int)role, endpoint);
            observeHresult?.Invoke("set", role, result.HResult);
        }
        public void Dispose() => native.Dispose();
        private static NativeSpotifyIdentity ToNative(SpotifyProcess value) =>
            new(checked((uint)value.Pid), value.StartTimeUtcTicks, value.UserSid,
                value.PolicyIdentity, value.ImageIdentity, value.Distribution);
    }
}
