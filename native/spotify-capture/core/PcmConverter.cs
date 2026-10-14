using System.Buffers.Binary;

namespace Folia.Capture;

public static class PcmConverter
{
    public static int Convert(CaptureFormat format, ReadOnlySpan<byte> input, Span<byte> output)
    {
        format.RequireSupported();
        if (input.Length % format.BlockAlign != 0) throw new CaptureFailure("CAPTURE_FRAME_INVALID");
        var samples = input.Length / (format.ContainerBits / 8);
        var required = checked(samples * 4);
        if (output.Length < required) throw new CaptureFailure("CAPTURE_BUFFER_INVALID");
        var stride = format.ContainerBits / 8;
        var paddingBits = format.ContainerBits - format.ValidBits;
        var paddingMask = paddingBits == 0 ? 0u : (1u << paddingBits) - 1;
        for (var sample = 0; sample < samples; sample++)
        {
            var bytes = input.Slice(sample * stride, stride);
            int value;
            if (format.Encoding == "float")
            {
                var number = BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(bytes));
                if (!float.IsFinite(number)) throw new CaptureFailure("CAPTURE_SAMPLE_NONFINITE");
                value = number >= 1 ? int.MaxValue : number <= -1 ? int.MinValue
                    : (int)Math.Round((double)number * 2147483648d, MidpointRounding.ToEven);
            }
            else
            {
                value = stride == 2 ? BinaryPrimitives.ReadInt16LittleEndian(bytes)
                    : stride == 3 ? (bytes[0] | bytes[1] << 8 | bytes[2] << 16) << 8 >> 8
                    : BinaryPrimitives.ReadInt32LittleEndian(bytes);
                // WAVEFORMATEXTENSIBLE PCM valid bits are MSB-aligned in the container.
                if (((uint)value & paddingMask) != 0) throw new CaptureFailure("CAPTURE_PADDING_NONZERO");
                value = unchecked(value << (32 - format.ContainerBits));
            }
            BinaryPrimitives.WriteInt32LittleEndian(output.Slice(sample * 4, 4), value);
        }
        return required;
    }
}
