using System.Runtime.InteropServices;

namespace Folia.Capture;

// Resolves an absent endpoint InstanceId through documented read-only endpoint topology.
internal interface IEndpointTopologyApi
{
    (int Result, IntPtr Handle) Enumerator();
    (int Result, IntPtr Handle) Device(IntPtr enumerator, string id);
    (int Result, IntPtr Handle) Topology(IntPtr device);
    (int Result, uint Count) ConnectorCount(IntPtr topology);
    (int Result, IntPtr Handle) Connector(IntPtr topology);
    (int Result, bool Connected) Connected(IntPtr connector);
    (int Result, string Id) ConnectedDeviceId(IntPtr connector);
    (int Result, IntPtr Handle) Properties(IntPtr device);
    (int Result, string Id) InstanceId(IntPtr properties);
    void Release(IntPtr handle);
}

internal static class EndpointIdentityProbe
{
    internal static BaseCableIdentityEvidence Read(string endpointId, string instanceId) =>
        Read(endpointId, instanceId, new TopologyApi(), BaseCableIdentityProbe.Read);

    internal static BaseCableIdentityEvidence Read(string endpointId, string instanceId,
        IEndpointTopologyApi api, Func<string, BaseCableIdentityEvidence> readIdentity)
    {
        // NAudio returns the literal sentinel "Unknown" when the optional property is absent.
        if (!string.IsNullOrWhiteSpace(instanceId) && !string.Equals(instanceId, "Unknown", StringComparison.OrdinalIgnoreCase))
            return readIdentity(instanceId);
        if (!Valid(endpointId, 512)) return new("unavailable", FailureStage: "endpoint-id");
        var owned = new List<IntPtr>();
        var stage = "topology-enumerator";
        BaseCableIdentityEvidence result = new("unavailable", FailureStage: stage);
        IntPtr Acquire((int Result, IntPtr Handle) value)
        {
            if (value.Handle != IntPtr.Zero) owned.Add(value.Handle);
            Require(value.Result);
            if (value.Handle == IntPtr.Zero) throw new TopologyFailure(stage, null);
            return value.Handle;
        }
        void Require(int hr) { if (hr != 0) throw new TopologyFailure(stage, hr); }
        try
        {
            var enumerator = Acquire(api.Enumerator());
            stage = "topology-endpoint"; var endpoint = Acquire(api.Device(enumerator, endpointId));
            stage = "topology-activate"; var topology = Acquire(api.Topology(endpoint));
            stage = "topology-connector-count"; var count = api.ConnectorCount(topology); Require(count.Result);
            // Audio endpoints have one connector. Never choose arbitrarily from an ambiguous graph.
            if (count.Count != 1) throw new TopologyFailure(stage, null);
            stage = "topology-connector"; var connector = Acquire(api.Connector(topology));
            stage = "topology-connected"; var connected = api.Connected(connector); Require(connected.Result);
            if (!connected.Connected) throw new TopologyFailure(stage, null);
            stage = "topology-adapter-id"; var adapterId = api.ConnectedDeviceId(connector); Require(adapterId.Result);
            if (!Valid(adapterId.Id, 512) || string.Equals(adapterId.Id, endpointId, StringComparison.OrdinalIgnoreCase))
                throw new TopologyFailure(stage, null);
            stage = "topology-adapter"; var adapter = Acquire(api.Device(enumerator, adapterId.Id));
            stage = "topology-properties"; var properties = Acquire(api.Properties(adapter));
            stage = "topology-instance-id"; var owner = api.InstanceId(properties); Require(owner.Result);
            if (!Valid(owner.Id, BaseCableIdentityProbe.MaxDeviceIdChars - 1)
                || string.Equals(owner.Id, "Unknown", StringComparison.OrdinalIgnoreCase)) throw new TopologyFailure(stage, null);
            result = readIdentity(owner.Id);
        }
        catch (TopologyFailure error)
        { result = new("unavailable", FailureStage: error.Stage, Hresult: error.Result); }
        catch (Exception error) when (ReadFailure(error))
        { result = new("unavailable", FailureStage: stage, Hresult: error is COMException ? error.HResult : null); }
        finally
        {
            for (var i = owned.Count - 1; i >= 0; i--)
            {
                try { api.Release(owned[i]); }
                catch (Exception error) when (ReadFailure(error))
                {
                    if (result.State == "verified") result = new("unavailable", FailureStage: "topology-release",
                        Hresult: error is COMException ? error.HResult : null);
                }
            }
        }
        return result;
    }

    private static bool Valid(string? value, int maximum) => !string.IsNullOrWhiteSpace(value)
        && value.Length <= maximum && !value.Any(char.IsControl);
    private static bool ReadFailure(Exception error) => error is COMException or DllNotFoundException
        or EntryPointNotFoundException or BadImageFormatException or InvalidCastException;
    private sealed class TopologyFailure(string stage, int? result) : Exception
    { internal string Stage => stage; internal int? Result => result; }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { internal Guid Format; internal uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyValue
    {
        [FieldOffset(0)] internal ushort Type;
        [FieldOffset(8)] internal IntPtr String;
    }

    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int CoCreateInstance(in Guid clsid, IntPtr outer, uint context, in Guid iid, out IntPtr value);
    [DllImport("ole32.dll", ExactSpelling = true)]
    private static extern int PropVariantClear(ref PropertyValue value);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetDevice(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Activate(IntPtr self, in Guid iid, uint context, IntPtr parameters, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetCount(IntPtr self, out uint count);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetConnector(IntPtr self, uint index, out IntPtr connector);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int IsConnected(IntPtr self, out int connected);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetString(IntPtr self, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int OpenProperties(IntPtr self, uint access, out IntPtr store);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetProperty(IntPtr self, in PropertyKey key, ref PropertyValue value);

    // Raw pointers let this small adapter check every HRESULT and deterministically release
    // its own references. No topology connect/disconnect, IAudioClient or setter slot is called.
    private sealed class TopologyApi : IEndpointTopologyApi
    {
        private static readonly Guid EnumeratorClass = new("bcde0395-e52f-467c-8e3d-c4579291692e");
        private static readonly Guid EnumeratorInterface = new("a95664d2-9614-4f35-a746-de8db63617e6");
        private static readonly Guid TopologyInterface = new("2a07407e-6497-4a18-9787-32f79bd0d98f");
        private static readonly PropertyKey InstanceKey = new() { Format = new("78c34fc8-104a-4aca-9ea4-524d52996e57"), Id = 256 };
        private static T Method<T>(IntPtr self, int slot) where T : Delegate =>
            Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size));
        public (int Result, IntPtr Handle) Enumerator()
        { var hr = CoCreateInstance(in EnumeratorClass, IntPtr.Zero, 1, in EnumeratorInterface, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Device(IntPtr enumerator, string id)
        { var hr = Method<GetDevice>(enumerator, 5)(enumerator, id, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Topology(IntPtr device)
        { var hr = Method<Activate>(device, 3)(device, in TopologyInterface, 23, IntPtr.Zero, out var value); return (hr, value); }
        public (int Result, uint Count) ConnectorCount(IntPtr topology)
        { var hr = Method<GetCount>(topology, 3)(topology, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Connector(IntPtr topology)
        { var hr = Method<GetConnector>(topology, 4)(topology, 0, out var value); return (hr, value); }
        public (int Result, bool Connected) Connected(IntPtr connector)
        { var hr = Method<IsConnected>(connector, 7)(connector, out var value); return (hr, value != 0); }
        public (int Result, string Id) ConnectedDeviceId(IntPtr connector)
        {
            IntPtr value = IntPtr.Zero;
            try { var hr = Method<GetString>(connector, 10)(connector, out value); return (hr, hr == 0 ? ReadString(value, 512) : ""); }
            finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
        }
        public (int Result, IntPtr Handle) Properties(IntPtr device)
        { var hr = Method<OpenProperties>(device, 4)(device, 0, out var value); return (hr, value); }
        public (int Result, string Id) InstanceId(IntPtr properties)
        {
            var value = new PropertyValue(); var hr = 0; var clear = 0; var id = string.Empty;
            try
            {
                hr = Method<GetProperty>(properties, 5)(properties, in InstanceKey, ref value);
                if (hr == 0 && value.Type == 31) id = ReadString(value.String, BaseCableIdentityProbe.MaxDeviceIdChars - 1);
            }
            finally { clear = PropVariantClear(ref value); }
            return (hr != 0 ? hr : clear, id);
        }
        public void Release(IntPtr handle) => Marshal.Release(handle);
        private static string ReadString(IntPtr value, int maximum)
        {
            if (value == IntPtr.Zero) return string.Empty;
            for (var length = 0; length <= maximum; length++)
                if (Marshal.ReadInt16(value, length * 2) == 0) return Marshal.PtrToStringUni(value, length) ?? string.Empty;
            return string.Empty;
        }
    }
}
