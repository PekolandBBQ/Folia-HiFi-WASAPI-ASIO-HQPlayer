using System.Buffers.Binary;

namespace Folia.Capture;

public sealed record CaptureFormat(int SampleRate, int Channels, int ContainerBits, int ValidBits,
    int BlockAlign, int AverageBytesPerSecond, string Encoding, uint ChannelMask, string? SubFormat)
{
    public const int SelectedRate = 44100;
    public const int SelectedChannels = 2;
    public const int OutputFrameBytes = 8;
    // Process loopback negotiates its own stream; VB endpoint descriptors are diagnostics only.
    public static CaptureFormat ProcessLoopback { get; } = new(44100, 2, 32, 32, 8, 352800, "float", 0, null);
    public static readonly Guid PcmSubtype = new("00000001-0000-0010-8000-00aa00389b71");
    public static readonly Guid FloatSubtype = new("00000003-0000-0010-8000-00aa00389b71");

    // The argument is WAVEFORMATEX/EXTENSIBLE bytes, without a RIFF chunk/header.
    public static CaptureFormat Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 18) throw new CaptureFailure("CAPTURE_FORMAT_INVALID");
        var tag = BinaryPrimitives.ReadUInt16LittleEndian(bytes);
        var channels = BinaryPrimitives.ReadUInt16LittleEndian(bytes[2..]);
        var rate = BinaryPrimitives.ReadInt32LittleEndian(bytes[4..]);
        var average = BinaryPrimitives.ReadInt32LittleEndian(bytes[8..]);
        var alignment = BinaryPrimitives.ReadUInt16LittleEndian(bytes[12..]);
        var bits = BinaryPrimitives.ReadUInt16LittleEndian(bytes[14..]);
        var validBits = (int)bits;
        uint mask = 0;
        string? subtype = null;
        var encoding = tag == 1 ? "pcm" : tag == 3 ? "float" : "unsupported";
        if (tag == 0xfffe)
        {
            if (bytes.Length < 40 || BinaryPrimitives.ReadUInt16LittleEndian(bytes[16..]) < 22)
                throw new CaptureFailure("CAPTURE_FORMAT_INVALID");
            validBits = BinaryPrimitives.ReadUInt16LittleEndian(bytes[18..]);
            mask = BinaryPrimitives.ReadUInt32LittleEndian(bytes[20..]);
            var id = new Guid(bytes.Slice(24, 16));
            subtype = id.ToString();
            encoding = id == PcmSubtype ? "pcm" : id == FloatSubtype ? "float" : "unsupported";
        }
        return new(rate, channels, bits, validBits, alignment, average, encoding, mask, subtype);
    }

    public string? ConfigurationIssue()
    {
        if (SampleRate != SelectedRate) return "CAPTURE_RATE_MISMATCH";
        if (Channels != SelectedChannels) return "CAPTURE_CHANNELS_MISMATCH";
        if (ChannelMask != 0 && ChannelMask != 3) return "CAPTURE_CHANNEL_LAYOUT_UNSUPPORTED";
        if (ContainerBits is not (16 or 24 or 32) || ValidBits < 1 || ValidBits > ContainerBits)
            return "CAPTURE_FORMAT_UNSUPPORTED";
        if (BlockAlign != Channels * (ContainerBits / 8) || AverageBytesPerSecond != SampleRate * BlockAlign)
            return "CAPTURE_FORMAT_INVALID";
        if (Encoding == "float") return ContainerBits == 32 && ValidBits == 32 ? null : "CAPTURE_FORMAT_UNSUPPORTED";
        return Encoding == "pcm" ? null : "CAPTURE_FORMAT_UNSUPPORTED";
    }

    public void RequireSupported()
    {
        if (ConfigurationIssue() is { } issue) throw new CaptureFailure(issue);
    }

    public byte[] ToWaveFormatEx()
    {
        var extensible = SubFormat != null;
        var bytes = new byte[extensible ? 40 : 18];
        BinaryPrimitives.WriteUInt16LittleEndian(bytes, (ushort)(extensible ? 0xfffe : Encoding == "pcm" ? 1 : Encoding == "float" ? 3 : 0));
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(2), checked((ushort)Channels));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(4), SampleRate);
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(8), AverageBytesPerSecond);
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(12), checked((ushort)BlockAlign));
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(14), checked((ushort)ContainerBits));
        if (extensible)
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(16), 22);
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(18), checked((ushort)ValidBits));
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(20), ChannelMask);
            new Guid(SubFormat!).TryWriteBytes(bytes.AsSpan(24));
        }
        return bytes;
    }
}
