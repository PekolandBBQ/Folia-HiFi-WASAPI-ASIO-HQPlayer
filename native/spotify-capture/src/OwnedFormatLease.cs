namespace Folia.Capture;

// Created, inspected, and released only by CaptureEngine's control STA.
internal sealed class OwnedFormatLease : IDisposable
{
    internal string CaptureId { get; }
    internal string RenderId { get; }
    internal Guid RenderGroupingId { get; }
    private readonly EndpointFormatPair before;
    private readonly ITemporaryFormatEndpoint renderKeeper;

    private OwnedFormatLease(ConfigurationEvidence initial, Guid renderGroupingId, ITemporaryFormatEndpoint renderKeeper)
    {
        CaptureId = initial.Capture.Id; RenderId = initial.Render.Id; RenderGroupingId = renderGroupingId;
        before = new(initial.Capture.ConfiguredMixFormat ?? initial.Capture.MixFormat,
            initial.Render.ConfiguredMixFormat ?? initial.Render.MixFormat); this.renderKeeper = renderKeeper;
    }

    internal static OwnedFormatLease Acquire(ConfigurationEvidence initial)
    {
        var renderGroup = Guid.NewGuid();
        // Keep a silent owned session for routing, without opening the VB capture pin
        // or changing the endpoint engine to the process stream's format.
        var keeper = NativeFormatLease.Acquire(initial.Render.Id, initial.Render.MixFormat, renderGroup,
            trackRenderSession: true, endpointRole: "render", preserveEndpointFormat: true);
        return new(initial, renderGroup, keeper);
    }

    internal FormatLeaseEvidence ReadEvidence()
    {
        var current = renderKeeper.ReadCurrent();
        return new(true, "held", true, before, new(before.Capture, current));
    }

    internal OwnedSilentRenderLeaseEvidence AttestSilentRenderLease(CaptureLease captureLease)
    {
        // A fresh owner-thread read observes worker failure before issuing proof.
        renderKeeper.ReadCurrent();
        var identity = NativeFormatLease.RenderSessions.AttestSilent(RenderId, RenderGroupingId);
        return new(captureLease.Session, captureLease.Generation, identity.EndpointId,
            identity.SessionInstanceId, identity.GroupingId, identity.ProcessId, identity.StartedAtUtcTicks);
    }

    public void Dispose() => renderKeeper.Dispose();
}
