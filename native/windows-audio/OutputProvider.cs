using System.Diagnostics;
using NAudio.Wave;

// native/windows-audio/OutputProvider.cs — PCM packing, gain, and a callback-derived ASIO clock.
namespace Folia.Audio;

internal sealed class OutputProvider(ISampleProvider source, WaveFormat format) : IWaveProvider
{
    private float[] samples = [];
    private long frames;
    private long callbackTicks;
    private long callbackStart;
    private int callbackFrames;
    public float Volume = 1;
    public WaveFormat WaveFormat { get; } = format;

    // Continue with silence at EOF. The owner drains the hardware latency before stopping;
    // no driver is stopped or disposed from its real-time callback.
    public int Read(byte[] buffer, int offset, int count)
    {
        var bytes = WaveFormat.BitsPerSample / 8;
        var length = count / bytes;
        if (samples.Length < length) samples = new float[length];
        var read = source.Read(samples, 0, length);
        Array.Clear(samples, read, length - read);
        var gain = Volatile.Read(ref Volume);
        for (var i = 0; i < length; i++)
        {
            var value = Math.Clamp(samples[i] * gain, -1f, 1f);
            var start = offset + i * bytes;
            if (WaveFormat.Encoding == WaveFormatEncoding.IeeeFloat)
            {
                BitConverter.TryWriteBytes(buffer.AsSpan(start, 4), value);
            }
            else
            {
                var scale = 1L << (WaveFormat.BitsPerSample - 1);
                var scaled = Math.Clamp((long)Math.Round(value * scale), -scale, scale - 1);
                for (var b = 0; b < bytes; b++) buffer[start + b] = (byte)(scaled >> (8 * b));
            }
        }
        Volatile.Write(ref callbackStart, frames);
        Volatile.Write(ref callbackFrames, length / WaveFormat.Channels);
        Volatile.Write(ref callbackTicks, Stopwatch.GetTimestamp());
        frames += length / WaveFormat.Channels;
        return count;
    }

    public double Position(double latency)
    {
        var ticks = Volatile.Read(ref callbackTicks);
        if (ticks == 0) return 0;
        var elapsed = (Stopwatch.GetTimestamp() - ticks) / (double)Stopwatch.Frequency;
        var ahead = Math.Min(elapsed, Volatile.Read(ref callbackFrames) / (double)WaveFormat.SampleRate);
        return Math.Max(0, Volatile.Read(ref callbackStart) / (double)WaveFormat.SampleRate + ahead - latency);
    }
}
