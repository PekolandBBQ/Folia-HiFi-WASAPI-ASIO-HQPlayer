namespace Folia.RouteResearch;

// Restore-only native proof: a complete current all-endpoint observation must
// include zero active sessions for the exact source process and zero active
// writers on the selected cable. An ordinary paused-source scan is insufficient.
public interface IRestoreQuiescenceObserver : ISessionObserver
{
    SessionObservation ObserveRestoreQuiescence(IBoundSpotifyPolicy process, TimeSpan maximumWait);
}
