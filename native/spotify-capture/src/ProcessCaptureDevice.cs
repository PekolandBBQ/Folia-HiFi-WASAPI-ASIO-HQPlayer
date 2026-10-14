using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace Folia.Capture;

// Constructed, called, and released exclusively by CaptureDeviceOwner's MTA.
internal sealed class ProcessCaptureDevice : ICaptureDevice
{


    private readonly AudioClient client;
    private readonly AudioCaptureClient capture;
    private readonly EventWaitHandle samplesReady;
    private readonly byte[] input, output;
    private readonly int maxFrames;
    public CaptureFormat Format { get; }
    public WaitHandle SamplesReady => samplesReady;

    internal static void ConfigureThread(Thread thread) => thread.SetApartmentState(ApartmentState.MTA);

    internal ProcessCaptureDevice(SpotifyProcessLease process, ConfigurationEvidence configuration)
    {
        process.RequireBootstrapProcess(EndpointInspector.SpotifyProcess(process.ProcessId));
        client = ProcessLoopbackActivation.Open(process.ProcessId);
        EventWaitHandle? openedEvent = null;
        try
        {
            Format = CaptureFormat.ProcessLoopback;
            Format.RequireSupported();
            client.Initialize(AudioClientShareMode.Shared,
                AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | AudioClientStreamFlags.AutoConvertPcm,
                0, 0, EndpointInspector.Wave(Format), Guid.Empty);
            samplesReady = openedEvent = new EventWaitHandle(false, EventResetMode.AutoReset);
            client.SetEventHandle(samplesReady.SafeWaitHandle.DangerousGetHandle());
            capture = client.AudioCaptureClient;
            maxFrames = Math.Max(client.BufferSize, 4410);
            if (maxFrames > 44100) throw new CaptureFailure("CAPTURE_DEVICE_BUFFER_TOO_LARGE");
            input = new byte[checked(maxFrames * Format.BlockAlign)]; output = new byte[checked(maxFrames * 8)];
        }
        catch { openedEvent?.Dispose(); client.Dispose(); throw; }
    }
    public void Start() => client.Start();
    public void Stop() => client.Stop();
    public void Reset() => client.Reset();
    public void ClearScratch() { Array.Clear(input); Array.Clear(output); }

    public bool ReadPacket(CaptureSession session)
    {
        if (capture.GetNextPacketSize() <= 0) return false;
        var pointer = capture.GetBuffer(out var frames, out var flags, out var position, out var qpc);
        try
        {
            if (frames <= 0) return true;
            if (frames > maxFrames) throw new CaptureFailure("CAPTURE_PACKET_TOO_LARGE");
            if ((flags & AudioClientBufferFlags.TimestampError) != 0) throw new CaptureFailure("CAPTURE_TIMESTAMP_ERROR");
            var discontinuity = (flags & AudioClientBufferFlags.DataDiscontinuity) != 0;
            if (session.Discarding) session.AcceptPacket(ReadOnlySpan<byte>.Empty, frames, position, qpc, discontinuity);
            else
            {
                var count = frames * 8;
                if ((flags & AudioClientBufferFlags.Silent) != 0) Array.Clear(output, 0, count);
                else
                {
                    if (pointer == IntPtr.Zero) throw new CaptureFailure("CAPTURE_PACKET_INVALID");
                    Marshal.Copy(pointer, input, 0, frames * Format.BlockAlign);
                    PcmConverter.Convert(Format, input.AsSpan(0, frames * Format.BlockAlign), output.AsSpan(0, count));
                }
                session.AcceptPacket(output.AsSpan(0, count), frames, position, qpc, discontinuity);
            }
        }
        catch (Exception error)
        {
            // Seal the read cause before ReleaseBuffer can supply a secondary error.
            session.Fail(CaptureFailureDiagnostic.From(error, "read")); throw;
        }
        finally { capture.ReleaseBuffer(frames); }
        return true;
    }

    public void Dispose()
    {
        ClearScratch();
        try { samplesReady.Dispose(); }
        finally { client.Dispose(); }
    }
}

