namespace Folia.Capture;

// core/FormatLeaseReadbackEvidence.cs: bounded facts from the existing failed format comparison.
public sealed record FormatLeaseReadbackFormat(int SampleRate, int Channels, int ContainerBits, int ValidBits,
    int BlockAlign, int AverageBytesPerSecond, string Encoding, uint ChannelMask, string SubFormatKind)
{
    internal static FormatLeaseReadbackFormat From(CaptureFormat value)
    {
        var kind = value.SubFormat == null ? "none"
            : Guid.TryParse(value.SubFormat, out var subtype) && subtype == CaptureFormat.PcmSubtype ? "pcm"
            : Guid.TryParse(value.SubFormat, out subtype) && subtype == CaptureFormat.FloatSubtype ? "float" : "other";
        return new(value.SampleRate, value.Channels, value.ContainerBits, value.ValidBits, value.BlockAlign,
            value.AverageBytesPerSecond, value.Encoding is "pcm" or "float" ? value.Encoding : "unsupported",
            value.ChannelMask, kind);
    }
}

public sealed record FormatLeaseReadbackEvidence(string EndpointRole, string Comparison, uint PeriodFrames,
    FormatLeaseReadbackFormat Requested, FormatLeaseReadbackFormat Observed, IReadOnlyList<string> DifferingFields)
{
    // Compare the original fields before sanitizing their display categories. Two
    // unknown subtype strings can differ even though both safely project to "other".
    internal static FormatLeaseReadbackEvidence? Create(CaptureFormat? requested, CaptureFormat observed,
        uint period, string? endpointRole, string comparison)
    {
        if (requested == null || endpointRole is not ("capture" or "render")) return null;
        var fields = new List<string>(9);
        if (requested.SampleRate != observed.SampleRate) fields.Add("sampleRate");
        if (requested.Channels != observed.Channels) fields.Add("channels");
        if (requested.ContainerBits != observed.ContainerBits) fields.Add("containerBits");
        if (requested.ValidBits != observed.ValidBits) fields.Add("validBits");
        if (requested.BlockAlign != observed.BlockAlign) fields.Add("blockAlign");
        if (requested.AverageBytesPerSecond != observed.AverageBytesPerSecond) fields.Add("averageBytesPerSecond");
        if (requested.Encoding != observed.Encoding) fields.Add("encoding");
        if (requested.ChannelMask != observed.ChannelMask) fields.Add("channelMask");
        if (requested.SubFormat != observed.SubFormat) fields.Add("subFormatKind");
        return new(endpointRole, comparison, period, FormatLeaseReadbackFormat.From(requested),
            FormatLeaseReadbackFormat.From(observed), fields.ToArray());
    }
}
