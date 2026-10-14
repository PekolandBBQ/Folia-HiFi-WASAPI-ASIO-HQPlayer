namespace Folia.RouteObservation;

// A sticky interval capability is distinct from a current complete snapshot.
// The native feed must classify every created/changed target control before it
// can retire, retain any foreign/unknown activity for the whole armed lifetime,
// and invalidate on topology/event loss. Pending publication cannot certify it.
public interface IReadOnlySessionIsolationFeed
{
    void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity) => throw new InvalidOperationException("OWNED_SILENT_RENDER_LEASE_UNSUPPORTED");
    void BeginIsolation(string renderEndpointId, uint verifiedOwnerPid, CancellationToken cancellationToken);
    bool IntervalIsolated { get; }
}
