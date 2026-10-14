namespace Folia.RouteObservation;

public enum AudioSessionState { Inactive = 0, Active = 1, Expired = 2 }
public enum SessionFeedEventKind { SessionChanged, EndpointTopologyChanged, EventLoss, DefaultChanged, EndpointPropertyChanged, EndpointInventoryChanged }
public sealed record SessionFeedEvent(SessionFeedEventKind Kind, string? EndpointId = null,
    string? SessionInstanceId = null);

// Keep HRESULTs: AUDCLNT_S_NO_SINGLE_PROCESS is a successful HRESULT but proves
// only the creator PID, never sole ownership. A display name is not identity.
public sealed record RawAudioSession(string SessionInstanceId, string EndpointId,
    AudioSessionState State, uint ReportedProcessId, int ProcessIdHResult,
    int SystemSoundsHResult, Guid? GroupingId = null, int? GroupingHResult = null)
{
    public const int NoSingleProcess = 0x0889000D;
}

public interface IReadOnlySessionFeed : IDisposable
{
    // Nonblocking final publication fence. False while any callback has entered
    // but not completed publication, notifications remain queued, or the feed
    // is unhealthy. The observer reads this before its final event revision.
    bool IsPublicationQuiescent { get; }
    // A timed-out Dispose is not proof that native observation work ended.
    bool IsStopped => false;
    // Register before the first endpoint enumeration. No callback may be lost:
    // callbacks that cannot be delivered must become an EventLoss notification.
    IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed,
        CancellationToken cancellationToken);
    string[] EnumerateActiveRenderEndpoints(CancellationToken cancellationToken);
    // Register manager notifications BEFORE GetCount/session enumeration. Retain
    // references from creation callbacks. Each subsequent read must union these
    // with enumeration; enumeration alone is explicitly insufficient in WASAPI.
    IEndpointSessionFeed OpenEndpoint(string endpointId, Action<SessionFeedEvent> changed,
        CancellationToken cancellationToken);
}

public interface IEndpointSessionFeed : IDisposable
{
    string EndpointId { get; }
    // Read exact live ID, PID HRESULT, system classification and state. Register
    // session event sinks before reading. Destroy/disconnect invalidates retained
    // rows. Callbacks must not register/unregister COM sinks themselves. All calls
    // must honor cancellation and discard results of canceled work.
    RawAudioSession[] ReadSessions(CancellationToken cancellationToken);
}

public sealed record ObservationOptions
{
    public TimeSpan QuietPeriod { get; init; } = TimeSpan.FromMilliseconds(50);
    public TimeSpan MaximumSnapshotAge { get; init; } = TimeSpan.FromMilliseconds(250);
    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(10);
}
