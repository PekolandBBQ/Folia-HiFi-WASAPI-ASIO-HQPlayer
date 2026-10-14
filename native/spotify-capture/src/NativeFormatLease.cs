using System.Runtime.InteropServices;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace Folia.Capture;

// Capture stays initialized on the control STA. Render is active on its dedicated
// owner STA and submits SILENT packets only. Both retain exact MATCH_FORMAT checks.
internal sealed class NativeFormatLease : ISilentRenderFormatEndpoint
{
    private IAudioClient3Native? client;
    private object? renderService, controlService;
    private SilentRenderBuffer? silent;
    internal static FormatLeaseSessionRegistry RenderSessions { get; } = FormatLeaseSessionRegistry.ForCurrentProcess();
    private FormatLeaseSessionIdentity? sessionIdentity;
    internal Guid GroupingId { get; }
    private readonly CaptureFormat requested;
    private readonly string? endpointRole;
    private NativeFormatLease(IAudioClient3Native client, Guid groupingId, CaptureFormat requested, string? endpointRole)
    { this.client = client; GroupingId = groupingId; this.requested = requested; this.endpointRole = endpointRole; }

    internal static ITemporaryFormatEndpoint Acquire(string endpointId, CaptureFormat previous, Guid groupingId, bool trackRenderSession = false,
        string? endpointRole = null) => trackRenderSession
        ? ActiveRenderFormatLease.Acquire(ready => AcquireCore(endpointId, previous, groupingId, endpointRole, ready),
            thread => thread.SetApartmentState(ApartmentState.STA))
        : AcquireCore(endpointId, previous, groupingId, endpointRole, null);

    private static NativeFormatLease AcquireCore(string endpointId, CaptureFormat previous, Guid groupingId,
        string? endpointRole, EventWaitHandle? bufferReady)
    {
        var selected = FormatLeasePolicy.Request(previous);
        var lease = new NativeFormatLease(Activate(endpointId), groupingId, selected, endpointRole);
        try
        {
            var client = lease.client!;
            var properties = new NativeAudioClientProperties { Size = 16, Offload = 0, Category = 0, Options = 2 };
            Check(client.SetClientProperties(ref properties));
            var bytes = selected.ToWaveFormatEx(); var pointer = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, pointer, bytes.Length);
                // No IsFormatSupported/closest-format/resampling fallback. Exact
                // initialization and complete current-engine readback decide success.
                Check(client.GetSharedModeEnginePeriod(pointer, out var normal, out var fundamental, out var minimum, out var maximum));
                FormatLeasePolicy.RequirePeriod(normal, fundamental, minimum, maximum);
                var sessionId = groupingId;
                Check(client.InitializeSharedAudioStream(bufferReady == null ? 0u : 0x00040000u,
                    normal, pointer, ref sessionId));
            }
            finally { Marshal.FreeHGlobal(pointer); }
            var sessionInterface = new Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD");
            Check(client.GetService(ref sessionInterface, out lease.controlService));
            var control = (IAudioSessionControl2)lease.controlService;
            Check(control.SetGroupingParam(groupingId, Guid.Empty));
            if (bufferReady != null)
            {
                var identity = AttestSession(control, endpointId, groupingId, 0);
                RenderSessions.Register(identity); lease.sessionIdentity = identity;
                var renderInterface = typeof(IAudioRenderClientNative).GUID;
                Check(client.GetService(ref renderInterface, out lease.renderService));
                Check(client.SetEventHandle(bufferReady.SafeWaitHandle.DangerousGetHandle()));
                bufferReady.Reset();
                lease.silent = new(new NativeSilentClient(client, (IAudioRenderClientNative)lease.renderService));
                lease.silent.Start();
                if (AttestSession(control, endpointId, groupingId, 1) != identity)
                    throw new CaptureFailure("FORMAT_LEASE_IDENTITY_UNAVAILABLE");
                using var process = System.Diagnostics.Process.GetCurrentProcess();
                RenderSessions.MarkSilentStarted(identity, process.StartTime.ToUniversalTime().Ticks);
            }
            ReleaseService(ref lease.controlService);
            lease.ReadCurrent(); return lease;
        }
        catch (Exception error) { throw FormatLeasePolicy.CleanupFailure(error, lease.Dispose); }
    }

    private static FormatLeaseSessionIdentity AttestSession(IAudioSessionControl2 control, string endpointId, Guid groupingId, int expectedState)
    {
        Check(control.GetSessionInstanceIdentifier(out var instance));
        var processResult = control.GetProcessId(out var processId); Check(processResult);
        Check(control.GetGroupingParam(out var group)); Check(control.GetState(out var state));
        if (processResult != 0 || processId != Environment.ProcessId || group != groupingId
            || (int)state != expectedState || control.IsSystemSoundsSession() != 1)
            throw new CaptureFailure("FORMAT_LEASE_IDENTITY_UNAVAILABLE");
        return new(endpointId, instance, group);
    }

    private sealed class NativeSilentClient(IAudioClient3Native client, IAudioRenderClientNative render) : ISilentRenderClient
    {
        public uint BufferFrames() { Check(client.GetBufferSize(out var frames)); return frames; }
        public uint PaddingFrames() { Check(client.GetCurrentPadding(out var frames)); return frames; }
        public void AcquireBuffer(uint frames) => Check(render.GetBuffer(frames, out _));
        public void ReleaseSilentBuffer(uint frames) => Check(render.ReleaseBuffer(frames, 2));
        public void Start() => Check(client.Start());
        public void Stop() { var result = client.Stop(); if (result != 1) Check(result); }
    }

    public void MaintainSilence() => (silent ?? throw new CaptureFailure("FORMAT_LEASE_CLOSED")).Maintain();

    internal static IAudioClient3Native Activate(string endpointId)
    {
        var type = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), true)!;
        var enumeratorObject = Activator.CreateInstance(type)!;
        IMMDeviceNative? device = null;
        try
        {
            var enumerator = (IMMDeviceEnumeratorNative)enumeratorObject;
            Check(enumerator.GetDevice(endpointId, out device));
            var id = typeof(IAudioClient3Native).GUID;
            Check(device.Activate(ref id, 23, IntPtr.Zero, out var client));
            try { return (IAudioClient3Native)client; }
            catch { Marshal.ReleaseComObject(client); throw; }
        }
        finally { if (device != null) Marshal.ReleaseComObject(device); Marshal.ReleaseComObject(enumeratorObject); }
    }

    internal static CaptureFormat ReadCurrent(string endpointId)
    {
        var client = Activate(endpointId);
        try { return ReadCurrent(client); }
        finally { Marshal.ReleaseComObject(client); }
    }

    internal static NAudio.CoreAudioApi.AudioClient OpenMatchedCapture(string endpointId, CaptureFormat format)
    {
        var native = Activate(endpointId);
        try
        {
            var properties = new NativeAudioClientProperties { Size = 16, Offload = 0, Category = 0, Options = 2 };
            Check(native.SetClientProperties(ref properties));
            ReadCurrent(native, format, "capture");
            var bytes = format.ToWaveFormatEx(); var pointer = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, pointer, bytes.Length);
                Check(native.GetSharedModeEnginePeriod(pointer, out var normal, out var fundamental, out var minimum, out var maximum));
                FormatLeasePolicy.RequirePeriod(normal, fundamental, minimum, maximum);
                var sessionId = Guid.Empty;
                // IAudioClient3 accepts EVENTCALLBACK, not the legacy NOPERSIST flag.
                // Capture sessions do not persist volume settings; no resampling flags.
                Check(native.InitializeSharedAudioStream(0x00040000u, normal, pointer, ref sessionId));
            }
            finally { Marshal.FreeHGlobal(pointer); }
            ReadCurrent(native, format, "capture");
            // AudioClient now owns this COM reference and releases it on the capture STA.
            return new NAudio.CoreAudioApi.AudioClient((IAudioClient)native);
        }
        catch { Marshal.ReleaseComObject(native); throw; }
    }

    private static CaptureFormat ReadCurrent(IAudioClient3Native client, CaptureFormat? requested = null, string? endpointRole = null)
    {
        var pointer = IntPtr.Zero;
        try
        {
            FormatLeasePolicy.CheckResult(client.GetCurrentSharedModeEnginePeriod(out pointer, out var period),
                "FORMAT_LEASE_READBACK_FAILED");
            if (pointer == IntPtr.Zero) throw new CaptureFailure("FORMAT_LEASE_READBACK_FAILED");
            return FormatLeasePolicy.RequireReadback(EndpointInspector.Format(WaveFormat.MarshalFromPtr(pointer)), period, requested, endpointRole);
        }
        finally { Marshal.FreeCoTaskMem(pointer); }
    }

    public CaptureFormat ReadCurrent() => ReadCurrent(client ?? throw new CaptureFailure("FORMAT_LEASE_CLOSED"), requested, endpointRole);

    internal static void Check(int result) => FormatLeasePolicy.CheckResult(result);

    public void Dispose()
    {
        if (client == null) return;
        var owned = client; client = null;
        Exception? first = null;
        void Cleanup(Action action) { try { action(); } catch (Exception error) { first ??= error; } }
        Cleanup(() => silent?.Stop());
        Cleanup(() => ReleaseService(ref controlService));
        Cleanup(() => ReleaseService(ref renderService));
        Cleanup(() => Marshal.ReleaseComObject(owned));
        if (sessionIdentity is { } identity)
        {
            if (first == null) RenderSessions.Retire(identity); else RenderSessions.Forget(identity);
        }
        if (first != null) throw FormatLeasePolicy.CleanupFailure(first);
    }

    private static void ReleaseService(ref object? service)
    {
        if (service == null) return;
        var owned = service; service = null;
        try { Marshal.ReleaseComObject(owned); }
        catch (Exception error)
        {
            throw FormatLeasePolicy.UnconfirmedCleanup(error);
        }
    }
}
