using Folia.Capture;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using System.Runtime.InteropServices;
using System.Text.Json;

// Hardware qualification only. Count samples without retaining user audio.
try
{
    using var client = ProcessLoopbackActivation.Open(int.Parse(args[0]));
    var bytes = CaptureFormat.ProcessLoopback.ToWaveFormatEx();
    var pointer = Marshal.AllocHGlobal(bytes.Length);
    WaveFormat format;
    try { Marshal.Copy(bytes, 0, pointer, bytes.Length); format = WaveFormat.MarshalFromPtr(pointer); }
    finally { Marshal.FreeHGlobal(pointer); }
    client.Initialize(AudioClientShareMode.Shared,
        AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | AudioClientStreamFlags.AutoConvertPcm,
        0, 0, format, Guid.Empty);
    using var ready = new AutoResetEvent(false);
    client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
    var capture = client.AudioCaptureClient;
    Console.WriteLine(JsonSerializer.Serialize(new { stage = "initialized", bufferFrames = client.BufferSize }));
    long frames = 0, nonzero = 0, gaps = 0;
    client.Start();
    var until = Environment.TickCount64 + (args.Length > 1 ? int.Parse(args[1]) : 10000);
    while (Environment.TickCount64 < until)
    {
        ready.WaitOne(100);
        while (capture.GetNextPacketSize() > 0)
        {
            var data = capture.GetBuffer(out var count, out var flags, out _, out _);
            try
            {
                frames += count;
                if ((flags & AudioClientBufferFlags.DataDiscontinuity) != 0) gaps++;
                if ((flags & AudioClientBufferFlags.Silent) == 0)
                {
                    var samples = new float[count * 2]; Marshal.Copy(data, samples, 0, samples.Length);
                    nonzero += samples.Count(value => value != 0);
                }
            }
            finally { capture.ReleaseBuffer(count); }
        }
    }
    client.Stop();
    Console.WriteLine(JsonSerializer.Serialize(new { processId = args[0], frames, nonzero, gaps, sampleRate = 44100, channels = 2 }));
    return 0;
}
catch (Exception error)
{
    Console.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, error.HResult, error.Message }));
    return 1;
}
