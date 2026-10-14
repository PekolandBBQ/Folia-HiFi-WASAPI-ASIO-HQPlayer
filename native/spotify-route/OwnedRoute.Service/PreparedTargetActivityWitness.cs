using Folia.RouteResearch;

namespace Folia.ProductRoute;

// Server-held historical activity, scoped to one exact retained preparation.
// It attests that a target stream ran, not that its IAudioClient survives Pause.
internal sealed record PreparedTargetActivityWitness(Guid TransactionId, string LeaseId, int Generation,
    SpotifyProcess Process, string SourceUri, string EndpointId, int PreparationEpoch,
    DateTimeOffset ObservedAtUtc, string[] SessionInstanceIds)
{
    internal bool Matches(RouteRecord route, string lease, int generation, string source, int epoch) =>
        TransactionId == route.TransactionId && LeaseId == lease && Generation == generation &&
        Process == route.CurrentProcess && SourceUri == source && EndpointId == route.Target.Id &&
        PreparationEpoch == epoch && SessionInstanceIds.Length > 0;
}
