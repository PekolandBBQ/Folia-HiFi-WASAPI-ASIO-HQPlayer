using System.Diagnostics;

// Exact identities of render leases created by this helper incarnation.
namespace Folia.Capture;

public readonly record struct FormatLeaseSessionIdentity(string EndpointId, string SessionInstanceId, Guid GroupingId);
public sealed record SilentRenderLeaseIdentity(string EndpointId, string SessionInstanceId, Guid GroupingId,
    int ProcessId, string StartedAtUtcTicks);

public sealed class FormatLeaseSessionRegistry(int processId, long startedAtUnixMs, int capacity = 256)
{
    // -1 is held. Nonnegative values order confirmed releases for bounded eviction.
    private readonly Dictionary<FormatLeaseSessionIdentity, long> sessions = [];
    private readonly Dictionary<FormatLeaseSessionIdentity, SilentRenderLeaseIdentity> activeSilent = [];
    private readonly object gate = new();
    private long releaseOrder;
    public int Count { get { lock (gate) return sessions.Count; } }

    public static FormatLeaseSessionRegistry ForCurrentProcess()
    {
        using var process = Process.GetCurrentProcess();
        return new(process.Id, new DateTimeOffset(process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds());
    }

    public void Register(FormatLeaseSessionIdentity identity)
    {
        lock (gate)
        {
            if (processId <= 0 || startedAtUnixMs <= 0 || capacity is < 1 or > 256
                || string.IsNullOrWhiteSpace(identity.EndpointId) || identity.EndpointId.Length > 512
                || string.IsNullOrWhiteSpace(identity.SessionInstanceId) || identity.SessionInstanceId.Length > 4096
                || identity.GroupingId == Guid.Empty || sessions.ContainsKey(identity))
                throw new CaptureFailure("FORMAT_LEASE_IDENTITY_UNAVAILABLE");
            if (sessions.Count >= capacity)
            {
                var retired = sessions.Where(item => item.Value >= 0).OrderBy(item => item.Value).ToArray();
                if (retired.Length == 0) throw new CaptureFailure("FORMAT_LEASE_IDENTITY_LIMIT");
                sessions.Remove(retired[0].Key); // An evicted lingering session fails closed.
            }
            sessions.Add(identity, -1);
        }
    }

    public void MarkSilentStarted(FormatLeaseSessionIdentity identity, long startedAtUtcTicks)
    {
        lock (gate)
        {
            if (!sessions.TryGetValue(identity, out var order) || order != -1 || activeSilent.ContainsKey(identity)
                || startedAtUtcTicks <= 0
                || new DateTimeOffset(new DateTime(startedAtUtcTicks, DateTimeKind.Utc)).ToUnixTimeMilliseconds() != startedAtUnixMs)
                throw new CaptureFailure("FORMAT_LEASE_IDENTITY_UNAVAILABLE");
            activeSilent.Add(identity, new(identity.EndpointId, identity.SessionInstanceId, identity.GroupingId,
                processId, startedAtUtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }
    }

    public SilentRenderLeaseIdentity AttestSilent(string endpointId, Guid groupingId)
    {
        lock (gate)
        {
            var matches = activeSilent.Where(item => item.Key.EndpointId == endpointId && item.Key.GroupingId == groupingId).ToArray();
            if (matches.Length != 1) throw new CaptureFailure("FORMAT_LEASE_IDENTITY_UNAVAILABLE");
            return matches[0].Value;
        }
    }

    public void Retire(FormatLeaseSessionIdentity identity)
    {
        lock (gate)
        {
            activeSilent.Remove(identity);
            if (sessions.TryGetValue(identity, out var order) && order < 0) sessions[identity] = releaseOrder++;
        }
    }

    public void Forget(FormatLeaseSessionIdentity identity)
    { lock (gate) { activeSilent.Remove(identity); sessions.Remove(identity); } }

    // Release ends format ownership, not the audio-session object's observable lifetime.
    // Retain only exact identities; never retain route readiness, formats or COM objects.
    public bool Owns(FormatLeaseSessionIdentity identity, RenderSessionEvidence observed)
    {
        lock (gate)
        {
            if (!sessions.ContainsKey(identity)) return false;
            if (observed.State != "inactive" && !(observed.State == "active" && activeSilent.ContainsKey(identity)))
            {
                activeSilent.Remove(identity); sessions.Remove(identity);
                return false;
            }
            return observed.IdentityReadable && !observed.IsSystemSounds && observed.ProcessId == processId
                && observed.StartedAtUnixMs == startedAtUnixMs;
        }
    }
}
