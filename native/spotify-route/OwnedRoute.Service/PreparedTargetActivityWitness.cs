using Folia.RouteResearch;

namespace Folia.ProductRoute;

// Server-held preparation proof, scoped to an exact owner and capture mode.
// Process capture proves identity/policy with a complete scan, not endpoint activity.
internal sealed record PreparedTargetActivityWitness(Guid TransactionId, string LeaseId, int Generation,
    SpotifyProcess Process, string SourceUri, string EndpointId, int PreparationEpoch,
    DateTimeOffset ObservedAtUtc, string[] SessionInstanceIds, bool RequiresEndpointActivity = true)
{
    internal bool Matches(RouteRecord route, string lease, int generation, string source, int epoch, bool requiresEndpointActivity = true) =>
        TransactionId == route.TransactionId && LeaseId == lease && Generation == generation &&
        Process == route.CurrentProcess && SourceUri == source && EndpointId == route.Target.Id &&
        PreparationEpoch == epoch && RequiresEndpointActivity == requiresEndpointActivity &&
        (!RequiresEndpointActivity || SessionInstanceIds.Length > 0);
}
