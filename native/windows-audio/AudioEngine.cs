using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

// native/windows-audio/AudioEngine.cs — local PCM playback, strict exclusive format negotiation.
namespace Folia.Audio;

internal sealed class AudioEngine(Action<object> emit) : IDisposable
{
    private IWavePlayer? output;
    private WaveFileReader? reader;
    private MMDevice? device;
    private OutputProvider? provider;
    private string session = "", path = "", backend = "", deviceId = "";
    private double position, duration, startPosition, latency;
    private int sampleRate, channels;
    private float volume = 1;
    private bool playing, ended;
    private string? driverError;
    private volatile bool resetRequested;
    private int resetAttempts;

    public object Command(JsonElement request)
    {
        var action = request.GetProperty("action").GetString();
        if (action == "devices") return Devices();
        if (action == "load")
        {
            CloseOutput();
            session = request.GetProperty("session").GetString()!;
            path = request.GetProperty("path").GetString()!;
            backend = request.GetProperty("backend").GetString()!;
            deviceId = request.GetProperty("deviceId").GetString()!;
            if (backend != "wasapi-exclusive" && backend != "asio") throw new ArgumentException("Unsupported backend");
            using var info = new WaveFileReader(path);
            var format = info.WaveFormat;
            var pcm = format.Encoding == WaveFormatEncoding.Pcm ||
                (format.Encoding == WaveFormatEncoding.Extensible && format is WaveFormatExtraData extra && format.ExtraSize >= 22 &&
                 new Guid(extra.ExtraData.AsSpan(6, 16)) == new Guid("00000001-0000-0010-8000-00aa00389b71"));
            if (!pcm || format.BitsPerSample != 24)
                throw new NotSupportedException("The helper requires decoded 24-bit PCM WAV input");
            duration = info.TotalTime.TotalSeconds;
            sampleRate = info.WaveFormat.SampleRate;
            channels = info.WaveFormat.Channels;
            position = startPosition = 0;
            ended = false;
            resetAttempts = 0;
            // Probe/open now: an unavailable device must fail the load, not silently use shared mode.
            try { OpenOutput(); } finally { CloseOutput(); }
            return Snapshot();
        }
        if (request.GetProperty("session").GetString() != session) throw new InvalidOperationException("Stale playback session");
        switch (action)
        {
            case "play":
                if (playing) break;
                if (ended) { position = 0; ended = false; }
                if (output == null) OpenOutput();
                output!.Play(); playing = true;
                break;
            case "pause":
                position = Position(); CloseOutput(); break;
            case "seek":
                var resume = playing;
                CloseOutput();
                position = Math.Clamp(request.GetProperty("position").GetDouble(), 0, duration);
                ended = false;
                if (resume) { OpenOutput(); output!.Play(); playing = true; }
                break;
            case "volume":
                volume = (float)Math.Clamp(request.GetProperty("volume").GetDouble(), 0, 1);
                if (provider != null) Volatile.Write(ref provider.Volume, volume);
                break;
            case "stop": CloseOutput(); position = 0; ended = false; break;
            default: throw new ArgumentException("Unknown audio command");
        }
        return Snapshot();
    }

    private static object Devices()
    {
        var results = new List<object>();
        using var enumerator = new MMDeviceEnumerator();
        foreach (var endpoint in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (endpoint) results.Add(new { backend = "wasapi-exclusive", id = endpoint.ID, name = endpoint.FriendlyName });
        }
        foreach (var name in AsioOut.GetDriverNames()) results.Add(new { backend = "asio", id = name, name });
        return results;
    }

    // Always reopen after pause/seek, flushing queued audio and rebasing both clocks.
    private void OpenOutput()
    {
        driverError = null;
        reader = new WaveFileReader(path);
        reader.CurrentTime = TimeSpan.FromSeconds(position);
        startPosition = reader.CurrentTime.TotalSeconds;
        // FFmpeg writes WAVEFORMATEXTENSIBLE for PCM24; NAudio's generic converter only
        // recognizes plain PCM tags, whereas this explicit converter supports both headers.
        var samples = new Pcm24BitToSampleProvider(reader);
        WaveFormat format = WaveFormat.CreateIeeeFloatWaveFormat(sampleRate, channels);
        if (backend == "wasapi-exclusive")
        {
            using var enumerator = new MMDeviceEnumerator();
            device = enumerator.GetDevice(deviceId);
            using var client = device.AudioClient;
            var formats = new[] { format, new WaveFormat(sampleRate, 32, channels),
                new WaveFormat(sampleRate, 24, channels), new WaveFormat(sampleRate, 16, channels) };
            format = formats.FirstOrDefault(f => client.IsFormatSupported(AudioClientShareMode.Exclusive, f))
                ?? throw new NotSupportedException($"Device cannot play {sampleRate} Hz / {channels} channels in exclusive mode");
            output = new WasapiOut(device, AudioClientShareMode.Exclusive, true, 100);
            latency = 0; // WASAPI position comes from the endpoint audio clock.
        }
        else
        {
            var asio = new AsioOut(deviceId) { AutoStop = false };
            asio.DriverResetRequest += (_, _) => resetRequested = true;
            output = asio;
        }
        provider = new OutputProvider(samples, format) { Volume = volume };
        output.Init(provider);
        resetRequested = false; // Init may itself change the driver's sample rate and buffer layout.
        if (output is AsioOut asioOutput) latency = asioOutput.PlaybackLatency / (double)sampleRate;
        output.PlaybackStopped += (_, e) => { if (e.Exception != null) driverError = e.Exception.Message; };
    }

    private double Position()
    {
        if (!playing || output == null) return position;
        var seconds = output is WasapiOut wasapi
            ? wasapi.GetPosition() / (double)wasapi.OutputWaveFormat.AverageBytesPerSecond
            : provider!.Position(latency);
        return Math.Clamp(startPosition + seconds, 0, duration);
    }

    private object Snapshot() => new { session, position = Position(), duration, playing, ended,
        sampleRate, channels, latency, backend, deviceId };

    public void Tick()
    {
        if (!playing) return;
        try
        {
            if (resetRequested)
            {
                // Some drivers report their sample-rate change asynchronously after Init.
                // Recreate once the callback has returned, never from the real-time thread.
                if (++resetAttempts > 2) throw new InvalidOperationException("ASIO driver repeatedly reset; select the device again");
                position = Position(); CloseOutput(); OpenOutput(); output!.Play(); playing = true;
            }
            if (driverError != null) throw new InvalidOperationException(driverError);
            position = Position();
            if (position >= duration)
            {
                CloseOutput(); position = duration; ended = true;
            }
            emit(new { @event = "state", state = Snapshot() });
        }
        catch (Exception error)
        {
            CloseOutput();
            emit(new { @event = "error", session, error = error.Message });
        }
    }

    private void CloseOutput()
    {
        playing = false;
        var previous = output;
        output = null;
        try { previous?.Stop(); } finally
        {
            previous?.Dispose(); reader?.Dispose(); device?.Dispose();
            reader = null; device = null; provider = null;
        }
    }

    public void Dispose() => CloseOutput();
}
