namespace Folia.Capture;

// Created, inspected, and released only by CaptureEngine's control STA.
internal sealed class OwnedFormatLease : IDisposable
{
    internal string CaptureId { get; }
    internal string RenderId { get; }
    internal Guid RenderGroupingId { get; }
    private readonly EndpointFormatPair before;
    private readonly TemporaryFormatPair pair;

    private OwnedFormatLease(ConfigurationEvidence initial, Guid renderGroupingId, TemporaryFormatPair pair)
    {
        CaptureId = initial.Capture.Id; RenderId = initial.Render.Id; RenderGroupingId = renderGroupingId;
        before = new(initial.Capture.ConfiguredMixFormat ?? initial.Capture.MixFormat,
            initial.Render.ConfiguredMixFormat ?? initial.Render.MixFormat); this.pair = pair;
    }

    internal static OwnedFormatLease Acquire(ConfigurationEvidence initial)
    {
        var captureGroup = Guid.NewGuid(); var renderGroup = Guid.NewGuid();
        var pair = TemporaryFormatPair.Acquire(
            () => NativeFormatLease.Acquire(initial.Capture.Id, initial.Capture.MixFormat, captureGroup, endpointRole: "capture"),
            () => NativeFormatLease.Acquire(initial.Render.Id, initial.Render.MixFormat, renderGroup, trackRenderSession: true, endpointRole: "render"));
        return new(initial, renderGroup, pair);
    }

    internal FormatLeaseEvidence ReadEvidence()
    {
        var current = pair.ReadCurrent();
        return new(true, "held", true, before, new(current.Capture, current.Render));
    }

    internal OwnedSilentRenderLeaseEvidence AttestSilentRenderLease(CaptureLease captureLease)
    {
        // A fresh owner-thread read observes worker failure before issuing proof.
        pair.ReadCurrent();
        var identity = NativeFormatLease.RenderSessions.AttestSilent(RenderId, RenderGroupingId);
        return new(captureLease.Session, captureLease.Generation, identity.EndpointId,
            identity.SessionInstanceId, identity.GroupingId, identity.ProcessId, identity.StartedAtUtcTicks);
    }

    public void Dispose() => pair.Dispose();
}
