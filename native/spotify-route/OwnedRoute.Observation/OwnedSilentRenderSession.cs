namespace Folia.RouteObservation;

// Only the product adapter's exact, process-verified, generation-bound lease may
// supply this exception. Sharing a PID or image name never matches another row.
public sealed record OwnedSilentRenderSession(string EndpointId, string SessionInstanceId, Guid GroupingId, uint ProcessId)
{
    public bool SameInstance(RawAudioSession row) => row.EndpointId == EndpointId && row.SessionInstanceId == SessionInstanceId;
    public bool Matches(RawAudioSession row) => SameInstance(row) && row.State == AudioSessionState.Active &&
        row.GroupingHResult == 0 && row.GroupingId == GroupingId && GroupingId != Guid.Empty &&
        row.ProcessIdHResult == 0 && row.ReportedProcessId == ProcessId && ProcessId > 0 && row.SystemSoundsHResult == 1;
}
