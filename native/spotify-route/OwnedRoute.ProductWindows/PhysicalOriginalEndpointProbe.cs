using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Folia.Capture;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

// Separate native property families: existing registry properties use REG_ types;
// BusTypeGuid/EnumeratorName use documented unified DEVPROP_ keys and types.
internal interface IPhysicalOriginalDeviceApi : IBaseCableIdentityApi
{
    (uint Result, uint Type, byte[] Bytes, uint Length) DeviceProperty(uint node, uint propertyId);
}

// A hardware association, not driver attestation. Read only the endpoint's actual
// MEDIA function and, when needed, its immediate physical USB/PCI parent. Never
// search higher in an unknown graph until something happens to look physical.
internal static class PhysicalOriginalEndpointProbe
{
    internal static readonly Guid UsbBus = new("9d7debbc-c85d-11d1-9eb4-006008c3a19a");
    internal static readonly Guid PciBus = new("c8ebdfb0-b510-11d0-80e5-00a0c92542e3");
    internal static readonly Guid SoftwareBus = new("06d10322-7de0-4cef-8e25-197d0e7442e2");
    internal const uint BusTypeProperty = 21, EnumeratorProperty = 24;
    internal static OriginalEndpointEvidence Read(EndpointInfo endpoint) => Read(endpoint, new TopologyApi(), new DeviceApi());
    internal static OriginalEndpointEvidence ReadForRestore(EndpointInfo endpoint) => Read(endpoint, new TopologyApi(), new DeviceApi(), requireStarted: false);
    internal static OriginalEndpointEvidence Read(EndpointInfo endpoint, IEndpointTopologyApi topology, IPhysicalOriginalDeviceApi devices, bool requireStarted = true)
    {
        var first = ReadOnce(endpoint, topology, devices, requireStarted);
        if (!first.Verified) return first;
        var second = ReadOnce(endpoint, topology, devices, requireStarted);
        if (!second.Verified) return second;
        return first.PhysicalIdentity == second.PhysicalIdentity ? first :
            new(false, Diagnostic: new("owner-repeat", "changed"));
    }
    private static OriginalEndpointEvidence ReadOnce(EndpointInfo endpoint, IEndpointTopologyApi topology, IPhysicalOriginalDeviceApi devices, bool requireStarted)
    {
        OriginalEndpointEvidence evidence = new(false);
        var observed = new ObservedTopology(topology);
        try
        {
            var result = EndpointIdentityProbe.Read(endpoint.Id, "", observed, instance =>
            {
                var chain = ReadOwner(instance, devices, requireStarted);
                // Full instance identities (including USB MI and serial), hardware,
                // service, native bus/enumerator and each actual edge are retained
                // privately for restoration. No IDs are copied into diagnostics.
                var fingerprint = System.Text.Json.JsonSerializer.Serialize(new
                { Version = 2, Adapter = observed.AdapterId.ToUpperInvariant(), Chain = chain });
                evidence = new(true, fingerprint);
                return new("verified", chain[0].Instance);
            });
            if (result.State == "verified") return evidence;
            return new(false, Diagnostic: new(result.FailureStage ?? "owner-identity",
                result.FailureStage == "topology-release" ? "release-failed" :
                result.Hresult is not null ? "api-failed" : "unavailable",
                NativeResult: result.ConfigRet, Hresult: result.Hresult));
        }
        catch (OwnerFailure error) { return new(false, Diagnostic: error.Diagnostic); }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        { return new(false, Diagnostic: new("owner-identity", "unavailable")); }
    }
    private sealed record NodeIdentity(string Instance, Guid Class, string Service, string[] Hardware, string Enumerator, Guid Bus);
    private sealed class OwnerFailure(PhysicalOwnerDiagnostic diagnostic) : Exception
    { internal PhysicalOwnerDiagnostic Diagnostic { get; } = diagnostic; }
    private static OwnerFailure Failed(string stage, string reason, int depth = 0, string? bus = null,
        uint? nativeResult = null, string? property = null, uint? type = null, uint? length = null) =>
        new(new(stage, reason, Depth: depth, NativeResult: nativeResult, Property: property,
            PropertyType: type, PropertyLength: length <= 4096 ? length : null, Bus: bus));

    private static NodeIdentity[] ReadOwner(string instance, IPhysicalOriginalDeviceApi api, bool requireStarted)
    {
        var located = api.Locate(instance);
        if (located.Result != 0) throw Failed("owner-locate", "api-failed", nativeResult: located.Result);
        var media = ReadNode(located.Node, api, requireStarted, 0);
        if (!string.Equals(media.Instance, instance, StringComparison.OrdinalIgnoreCase))
            throw Failed("owner-device-id", "mismatch");
        if (media.Class != BaseCableIdentity.MediaClass) throw Failed("owner-class-guid", "unsupported");
        var kind = Kind(media);
        if (kind is "usb" or "pci")
        {
            RequireAnchor(media, kind, 0);
            return [media];
        }
        // A vendor MEDIA function may legitimately have vendor-specific hardware
        // IDs. Its own strings are not physical proof: require its direct USB
        // parent. HDAUDIO similarly requires its direct physical PCI controller.
        if (kind == "hdaudio") RequireHardware(media, "HDAUDIO", 0);
        var parent = api.Parent(located.Node);
        if (parent.Result != 0) throw Failed("owner-parent", "api-failed", bus: kind, nativeResult: parent.Result);
        if (parent.Node == located.Node) throw Failed("owner-parent", "cycle", bus: kind);
        var anchor = ReadNode(parent.Node, api, requireStarted, 1);
        if (anchor.Instance == media.Instance) throw Failed("owner-parent", "cycle", 1, kind);
        RequireAnchor(anchor, kind == "hdaudio" ? "pci" : "usb", 1);
        // Recheck the exact edge before accepting even this bounded snapshot.
        var check = api.Parent(located.Node);
        if (check.Result != 0) throw Failed("owner-parent", "api-failed", nativeResult: check.Result);
        if (check.Node != parent.Node) throw Failed("owner-parent", "changed");
        return [media, anchor];
    }
    private static NodeIdentity ReadNode(uint node, IPhysicalOriginalDeviceApi api, bool requireStarted, int depth)
    {
        var id = api.DeviceId(node);
        if (id.Result != 0) throw Failed("owner-device-id", "api-failed", depth, nativeResult: id.Result);
        if (!ValidId(id.InstanceId)) throw Failed("owner-device-id", "malformed", depth);
        var parts = id.InstanceId.Split('\\');
        if (parts.Length != 3 || parts.Any(string.IsNullOrWhiteSpace)) throw Failed("owner-device-id", "malformed", depth);
        if (IsVirtual(parts[0])) throw Failed("owner-identity", "virtual", depth, "virtual");
        var enumerator = Text(api.DeviceProperty(node, EnumeratorProperty), false, 0x12, "enumerator", depth)[0];
        if (IsVirtual(enumerator)) throw Failed("owner-enumerator", "virtual", depth, "virtual");
        if (!string.Equals(parts[0], enumerator, StringComparison.OrdinalIgnoreCase))
            throw Failed("owner-enumerator", "mismatch", depth);
        var busValue = api.DeviceProperty(node, BusTypeProperty);
        // Some vendor MEDIA functions (observed Thesycon USB audio) omit BusTypeGuid.
        // Only the function may omit it; ReadOwner still requires its immediate USB anchor.
        var missingVendorBus = depth == 0 && busValue.Result == 37 && busValue.Type == 0 && busValue.Length == 0
            && !new[] { "USB", "PCI", "HDAUDIO" }.Contains(enumerator.ToUpperInvariant());
        if (!missingVendorBus) CheckProperty(busValue, 0xD, 16, "bus-type", depth);
        if (!missingVendorBus && busValue.Length != 16) throw PropertyFailure(busValue, "malformed", "bus-type", depth);
        var bus = missingVendorBus ? Guid.Empty : new Guid(busValue.Bytes.AsSpan(0, 16));
        if (!missingVendorBus && bus == Guid.Empty) throw Failed("owner-bus-type", "unsupported", depth, "unknown");
        if (bus == SoftwareBus) throw Failed("owner-bus-type", "virtual", depth, "virtual");
        var classText = Text(api.Property(node, 9), false, 1, "class-guid", depth)[0];
        if (!Guid.TryParse(classText, out var classId) || classId == Guid.Empty)
            throw Failed("owner-class-guid", "malformed", depth, property: "class-guid");
        var hardware = Text(api.Property(node, 2), true, 7, "hardware-ids", depth);
        var service = Text(api.Property(node, 5), false, 1, "service", depth)[0];
        var status = api.Status(node);
        if (status.Result != 0) throw Failed("owner-status", "api-failed", depth, nativeResult: status.Result);
        if ((status.Status & 0x400) != 0) throw Failed("owner-status", "has-problem", depth);
        if (requireStarted && (status.Status & 8) == 0) throw Failed("owner-status", "not-started", depth);
        var recheckedId = api.DeviceId(node);
        if (recheckedId.Result != 0) throw Failed("owner-device-id", "api-failed", depth, nativeResult: recheckedId.Result);
        if (!string.Equals(id.InstanceId, recheckedId.InstanceId, StringComparison.OrdinalIgnoreCase))
            throw Failed("owner-device-id", "changed", depth);
        return new(id.InstanceId.ToUpperInvariant(), classId, service.ToUpperInvariant(),
            hardware.Select(value => value.ToUpperInvariant()).Order(StringComparer.Ordinal).ToArray(), enumerator.ToUpperInvariant(), bus);
    }
    private static bool IsVirtual(string value) => value.Equals("ROOT", StringComparison.OrdinalIgnoreCase) || value.Equals("SWD", StringComparison.OrdinalIgnoreCase);
    private static string Kind(NodeIdentity value) => value.Enumerator switch
    { "USB" => "usb", "PCI" => "pci", "HDAUDIO" => "hdaudio", _ => "vendor" };
    private static void RequireAnchor(NodeIdentity value, string kind, int depth)
    {
        var actual = Kind(value);
        if (actual != kind || value.Bus != (kind == "usb" ? UsbBus : PciBus))
            throw Failed("owner-bus-type", "unsupported", depth, actual);
        RequireHardware(value, kind == "usb" ? "USB" : "PCI", depth);
    }
    private static void RequireHardware(NodeIdentity value, string prefix, int depth)
    {
        var key = PhysicalKey(value.Instance);
        if (key is null || !key.StartsWith(prefix + "\\", StringComparison.Ordinal))
            throw Failed("owner-identity", "unsupported", depth, Kind(value));
        if (value.Hardware.Any(item => PhysicalKey(item) != key))
            throw Failed("owner-hardware-ids", "mismatch", depth, Kind(value), property: "hardware-ids");
    }
    internal static string? PhysicalKey(string value)
    {
        if (!ValidId(value)) return null;
        var parts = value.ToUpperInvariant().Split('\\');
        if (parts.Length is < 2 or > 3 || parts.Any(string.IsNullOrWhiteSpace)) return null;
        if (parts[0] == "USB")
        {
            var match = Regex.Match(parts[1], @"^(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(?:&REV_[0-9A-F]{4})?(&MI_[0-9A-F]{2})?$",
                RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
            return match.Success ? "USB\\" + match.Groups[1].Value + match.Groups[2].Value : null;
        }
        foreach (var pattern in new[] { @"^(HDAUDIO\\FUNC_01&VEN_[0-9A-F]{4}&DEV_[0-9A-F]{4})(?:&|\\|$)",
            @"^(PCI\\VEN_[0-9A-F]{4}&DEV_[0-9A-F]{4})(?:&|\\|$)" })
        {
            var match = Regex.Match(value.ToUpperInvariant(), pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50));
            if (match.Success) return match.Groups[1].Value;
        }
        return null;
    }
    private static bool ValidId(string value) => !string.IsNullOrWhiteSpace(value) && value.Length < BaseCableIdentityProbe.MaxDeviceIdChars && !value.Any(char.IsControl);
    private static OwnerFailure PropertyFailure((uint Result, uint Type, byte[] Bytes, uint Length) value, string reason, string property, int depth) =>
        Failed("owner-" + property, reason, depth, nativeResult: value.Result, property: property, type: value.Type, length: value.Length);
    private static void CheckProperty((uint Result, uint Type, byte[] Bytes, uint Length) value, uint type, uint minimum, string property, int depth)
    {
        if (value.Result != 0) throw PropertyFailure(value, "api-failed", property, depth);
        if (value.Type != type) throw PropertyFailure(value, "wrong-type", property, depth);
        if (value.Length > BaseCableIdentityProbe.MaxPropertyBytes || value.Length > value.Bytes.Length || value.Length < minimum)
            throw PropertyFailure(value, "out-of-bounds", property, depth);
    }
    private static string[] Text((uint Result, uint Type, byte[] Bytes, uint Length) value, bool multiple, uint type, string property, int depth)
    {
        CheckProperty(value, type, multiple ? 4u : 2u, property, depth);
        if ((value.Length & 1) != 0) throw PropertyFailure(value, "malformed", property, depth);
        string text;
        try { text = new UnicodeEncoding(false, false, true).GetString(value.Bytes, 0, (int)value.Length); }
        catch (DecoderFallbackException) { throw PropertyFailure(value, "malformed", property, depth); }
        var terminators = multiple ? 2 : 1;
        if (!text.EndsWith(new string('\0', terminators), StringComparison.Ordinal)) throw PropertyFailure(value, "malformed", property, depth);
        var parts = text[..^terminators].Split('\0');
        if (parts.Any(part => string.IsNullOrWhiteSpace(part) || part.Any(char.IsControl)) || (!multiple && parts.Length != 1))
            throw PropertyFailure(value, "malformed", property, depth);
        return parts;
    }
    private sealed class ObservedTopology(IEndpointTopologyApi inner) : IEndpointTopologyApi
    {
        internal string AdapterId { get; private set; } = "";
        public (int Result, IntPtr Handle) Enumerator() => inner.Enumerator();
        public (int Result, IntPtr Handle) Device(IntPtr parent, string id) => inner.Device(parent, id);
        public (int Result, IntPtr Handle) Topology(IntPtr device) => inner.Topology(device);
        public (int Result, uint Count) ConnectorCount(IntPtr topology) => inner.ConnectorCount(topology);
        public (int Result, IntPtr Handle) Connector(IntPtr topology) => inner.Connector(topology);
        public (int Result, bool Connected) Connected(IntPtr connector) => inner.Connected(connector);
        public (int Result, string Id) ConnectedDeviceId(IntPtr connector)
        { var value = inner.ConnectedDeviceId(connector); AdapterId = value.Id; return value; }
        public (int Result, IntPtr Handle) Properties(IntPtr device) => inner.Properties(device);
        public (int Result, string Id) InstanceId(IntPtr properties) => inner.InstanceId(properties);
        public void Release(IntPtr handle) => inner.Release(handle);
    }

    // Same documented Configuration Manager getter ABI/bounds as the A025 probe.
    private sealed class DeviceApi : IPhysicalOriginalDeviceApi
    {
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Locate_DevNodeW(out uint node, string id, uint flags);
        [DllImport("cfgmgr32.dll", ExactSpelling = true)] private static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Get_Device_IDW(uint node, [Out] char[] buffer, uint length, uint flags);
        [DllImport("cfgmgr32.dll", ExactSpelling = true)] private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Get_DevNode_Registry_PropertyW(uint node, uint property, out uint type, [Out] byte[] buffer, ref uint length, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern uint CM_Get_DevNode_PropertyW(uint node, in Key key, out uint type, [Out] byte[] buffer, ref uint length, uint flags);
        public (uint Result, uint Type, byte[] Bytes, uint Length) DeviceProperty(uint node, uint propertyId)
        {
            var key = new Key { Format = new("a45c254e-df1c-4efd-8020-67d146a850e0"), Id = propertyId };
            var bytes = new byte[BaseCableIdentityProbe.MaxPropertyBytes]; var length = (uint)bytes.Length;
            var result = CM_Get_DevNode_PropertyW(node, in key, out var type, bytes, ref length, 0);
            return (result, type, bytes, length);
        }
        public (uint Result, uint Node) Locate(string id) { var result = CM_Locate_DevNodeW(out var node, id, 0); return (result, node); }
        public (uint Result, uint Node) Parent(uint node) { var result = CM_Get_Parent(out var parent, node, 0); return (result, parent); }
        public (uint Result, string InstanceId) DeviceId(uint node)
        {
            var chars = Enumerable.Repeat('\uffff', BaseCableIdentityProbe.MaxDeviceIdChars).ToArray();
            var result = CM_Get_Device_IDW(node, chars, (uint)chars.Length, 0); var end = Array.IndexOf(chars, '\0');
            return (result, end > 0 ? new string(chars, 0, end) : "");
        }
        public (uint Result, uint Status) Status(uint node) { var result = CM_Get_DevNode_Status(out var status, out _, node, 0); return (result, status); }
        public (uint Result, uint Type, byte[] Bytes, uint Length) Property(uint node, uint property)
        {
            var bytes = new byte[BaseCableIdentityProbe.MaxPropertyBytes]; var length = (uint)bytes.Length;
            var result = CM_Get_DevNode_Registry_PropertyW(node, property, out var type, bytes, ref length, 0); return (result, type, bytes, length);
        }
    }

    // Read-only endpoint adapter shared structurally with EndpointIdentityProbe.
    // No connect/disconnect, stream initialization or setting operation is bound.
    [StructLayout(LayoutKind.Sequential)] private struct Key { internal Guid Format; internal uint Id; }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct Value { [FieldOffset(0)] internal ushort Type; [FieldOffset(8)] internal IntPtr String; }
    [DllImport("ole32.dll", ExactSpelling = true)] private static extern int CoCreateInstance(in Guid clsid, IntPtr outer, uint context, in Guid iid, out IntPtr value);
    [DllImport("ole32.dll", ExactSpelling = true)] private static extern int PropVariantClear(ref Value value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DeviceFn(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ActivateFn(IntPtr self, in Guid iid, uint context, IntPtr args, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CountFn(IntPtr self, out uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ItemFn(IntPtr self, uint index, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int BoolFn(IntPtr self, out int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int StringFn(IntPtr self, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int OpenFn(IntPtr self, uint mode, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PropertyFn(IntPtr self, in Key key, ref Value value);
    private sealed class TopologyApi : IEndpointTopologyApi
    {
        private static readonly Guid Class = new("bcde0395-e52f-467c-8e3d-c4579291692e"), Interface = new("a95664d2-9614-4f35-a746-de8db63617e6"), TopologyId = new("2a07407e-6497-4a18-9787-32f79bd0d98f");
        private static readonly Key InstanceKey = new() { Format = new("78c34fc8-104a-4aca-9ea4-524d52996e57"), Id = 256 };
        private static T Slot<T>(IntPtr self, int slot) where T : Delegate => Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size));
        public (int Result, IntPtr Handle) Enumerator() { var hr = CoCreateInstance(in Class, IntPtr.Zero, 1, in Interface, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Device(IntPtr parent, string id) { var hr = Slot<DeviceFn>(parent, 5)(parent, id, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Topology(IntPtr device) { var hr = Slot<ActivateFn>(device, 3)(device, in TopologyId, 23, IntPtr.Zero, out var value); return (hr, value); }
        public (int Result, uint Count) ConnectorCount(IntPtr topology) { var hr = Slot<CountFn>(topology, 3)(topology, out var value); return (hr, value); }
        public (int Result, IntPtr Handle) Connector(IntPtr topology) { var hr = Slot<ItemFn>(topology, 4)(topology, 0, out var value); return (hr, value); }
        public (int Result, bool Connected) Connected(IntPtr connector) { var hr = Slot<BoolFn>(connector, 7)(connector, out var value); return (hr, value != 0); }
        public (int Result, string Id) ConnectedDeviceId(IntPtr connector)
        {
            IntPtr value = IntPtr.Zero;
            try { var hr = Slot<StringFn>(connector, 10)(connector, out value); return (hr, hr == 0 ? ReadString(value, 512) : ""); }
            finally { if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
        }
        public (int Result, IntPtr Handle) Properties(IntPtr device) { var hr = Slot<OpenFn>(device, 4)(device, 0, out var value); return (hr, value); }
        public (int Result, string Id) InstanceId(IntPtr properties)
        {
            var value = new Value(); var result = 0; var clear = 0; var id = "";
            try { result = Slot<PropertyFn>(properties, 5)(properties, in InstanceKey, ref value); if (result == 0 && value.Type == 31) id = ReadString(value.String, BaseCableIdentityProbe.MaxDeviceIdChars - 1); }
            finally { clear = PropVariantClear(ref value); }
            return (result != 0 ? result : clear, id);
        }
        public void Release(IntPtr handle) => Marshal.Release(handle);
        private static string ReadString(IntPtr value, int maximum)
        {
            if (value == IntPtr.Zero) return "";
            for (var i = 0; i <= maximum; i++) if (Marshal.ReadInt16(value, i * 2) == 0) return Marshal.PtrToStringUni(value, i) ?? "";
            return "";
        }
    }
}
