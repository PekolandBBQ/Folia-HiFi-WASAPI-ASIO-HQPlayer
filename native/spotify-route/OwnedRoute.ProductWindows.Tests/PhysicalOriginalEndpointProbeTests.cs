using System.Runtime.InteropServices;
using System.Text;
using Folia.Capture;
using Folia.RouteRunner;

internal static class PhysicalOriginalEndpointProbeTests
{
    private const string EndpointId = "{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}";
    private static readonly Guid Media = new("4d36e96c-e325-11ce-bfc1-08002be10318");
    private static readonly Guid Usb = new("9d7debbc-c85d-11d1-9eb4-006008c3a19a");
    private static readonly Guid Pci = new("c8ebdfb0-b510-11d0-80e5-00a0c92542e3");
    private static readonly Guid Vendor = new("12121212-1212-1212-1212-121212121212");
    private static readonly Guid Software = new("06d10322-7de0-4cef-8e25-197d0e7442e2");
    internal static int Run()
    {
        var count = 0;
        void Require(bool value) { if (!value) throw new Exception("Physical owner assertion failed"); }
        void Test(string name, Action action) { action(); count++; Console.WriteLine("PASS physical owner " + name); }
        OriginalEndpointEvidence Probe(Fixture fixture, bool started = true) => PhysicalOriginalEndpointProbe.Read(
            new(EndpointId, "USB-looking friendly name is not evidence", 1, 0, 1, "ignored-endpoint-id", new("unsupported"), null, 48000, 2),
            fixture.Topology, fixture, started);
        void Reject(Fixture fixture, string stage, string reason, bool started = true)
        { var proof = Probe(fixture, started); Require(!proof.Verified && proof.PhysicalIdentity is null && proof.Diagnostic?.Stage == stage && proof.Diagnostic?.Reason == reason); }

        Test("direct USB uses exact topology device and adapter properties twice", () =>
        { var f = new Fixture(); var p = Probe(f); Require(p.Verified && f.Reads == 2 && f.Topology.DeviceIds.SequenceEqual(new[] { EndpointId, "adapter-id", EndpointId, "adapter-id" }) && f.Topology.Released.Count == 12); });
        Test("USB composite retains matching MI identity", () =>
        { var f = new Fixture(); f.Nodes[1].Id = @"USB\VID_1234&PID_5678&MI_00\secret-serial"; f.Nodes[1].Hardware = [@"USB\VID_1234&PID_5678&REV_0100&MI_00", @"USB\VID_1234&PID_5678&MI_00"]; Require(Probe(f).Verified); });
        Test("different composite MI is rejected", () =>
        { var f = new Fixture(); f.Nodes[1].Id = @"USB\VID_1234&PID_5678&MI_00\secret-serial"; f.Nodes[1].Hardware = [@"USB\VID_1234&PID_5678&MI_01"]; Reject(f, "owner-hardware-ids", "mismatch"); });
        Test("missing composite MI is rejected in either direction", () =>
        {
            var f = new Fixture(); f.Nodes[1].Id = @"USB\VID_1234&PID_5678&MI_00\secret-serial"; Reject(f, "owner-hardware-ids", "mismatch");
            f = new Fixture(); f.Nodes[1].Hardware = [@"USB\VID_1234&PID_5678&MI_00"]; Reject(f, "owner-hardware-ids", "mismatch");
        });
        Test("vendor MEDIA under direct native USB anchor succeeds", () =>
        { var f = Fixture.VendorUsb(); var proof = Probe(f); Require(proof.Verified && proof.PhysicalIdentity!.Contains("VENDORBUS", StringComparison.Ordinal) && proof.PhysicalIdentity.Contains("SECRET-SERIAL", StringComparison.Ordinal)); });
        Test("vendor MEDIA own unknown bus never substitutes for anchor", () =>
        { var f = Fixture.VendorUsb(); f.Nodes[2].Bus = Vendor; Reject(f, "owner-bus-type", "unsupported"); });
        Test("vendor missing function bus requires a verified immediate USB parent", () =>
        {
            var f = Fixture.VendorUsb(); f.Overrides[(1, true, 21)] = (37, 0, [], 0);
            Require(Probe(f).Verified);
            f.Overrides[(2, true, 21)] = (37, 0, [], 0); Reject(f, "owner-bus-type", "api-failed");
        });
        Test("unknown intermediate cannot be traversed to a convenient USB node", () =>
        { var f = Fixture.VendorUsb(); f.Nodes[3] = f.Nodes[2]; f.Nodes[2] = Node.VendorNode() with { Id = @"BRIDGEBUS\Bridge\middle", Enumerator = "BRIDGEBUS" }; f.Parents[2] = 3; Reject(f, "owner-bus-type", "unsupported"); Require(f.ParentCalls.All(value => value == 1)); });
        Test("direct PCI MEDIA requires actual PCI bus", () =>
        { var f = new Fixture(); f.Nodes[1] = Node.PciNode() with { Class = Media }; Require(Probe(f).Verified); f.Nodes[1].Bus = Usb; Reject(f, "owner-bus-type", "unsupported"); });
        Test("HDAUDIO codec keeps different actual PCI controller identity", () =>
        { var f = Fixture.HdAudio(); Require(Probe(f).Verified); f.Nodes[2].Enumerator = "USB"; Reject(f, "owner-enumerator", "mismatch"); });
        Test("HDAUDIO without actual PCI parent fails", () =>
        { var f = Fixture.HdAudio(); f.Parents.Clear(); Reject(f, "owner-parent", "api-failed"); });
        Test("ROOT and SWD MEDIA cannot borrow physical parent", () =>
        {
            foreach (var prefix in new[] { "ROOT", "SWD" })
            { var f = Fixture.VendorUsb(); f.Nodes[1].Id = prefix + @"\MEDIA\secret"; f.Nodes[1].Enumerator = prefix; Reject(f, "owner-identity", "virtual"); Require(f.ParentCalls.Count == 0); }
        });
        Test("ROOT and SWD native enumerators reject despite vendor-looking ID", () =>
        { foreach (var enumerator in new[] { "ROOT", "SWD" }) { var f = Fixture.VendorUsb(); f.Nodes[1].Enumerator = enumerator; Reject(f, "owner-enumerator", "virtual"); } });
        Test("software bus rejects USB-looking hardware", () =>
        { var f = new Fixture(); f.Nodes[1].Bus = Software; Reject(f, "owner-bus-type", "virtual"); });
        Test("canonical USB cannot fall through to vendor parent acceptance", () =>
        { var f = new Fixture(); f.Nodes[1].Bus = Vendor; f.Nodes[2] = Node.UsbNode(); f.Parents[1] = 2; Reject(f, "owner-bus-type", "unsupported"); Require(f.ParentCalls.Count == 0); });
        Test("invalid native bus type and length retain safe metadata", () =>
        {
            var f = new Fixture(); f.Overrides[(1, true, 21)] = (0, 3, Usb.ToByteArray(), 16);
            var result = Probe(f); Require(result.Diagnostic is { Stage: "owner-bus-type", Reason: "wrong-type", Property: "bus-type", PropertyType: 3, PropertyLength: 16 });
            f.Overrides[(1, true, 21)] = (0, 13, new byte[15], 15); Reject(f, "owner-bus-type", "out-of-bounds");
            f.Overrides[(1, true, 21)] = (0, 13, new byte[17], 17); Reject(f, "owner-bus-type", "malformed");
        });
        Test("unified enumerator rejects registry-string type", () =>
        { var f = new Fixture(); f.Overrides[(1, true, 24)] = String("USB", 1); Reject(f, "owner-enumerator", "wrong-type"); });
        Test("legacy class GUID rejects unified binary GUID type", () =>
        { var f = new Fixture(); f.Overrides[(1, false, 9)] = (0, 13, Media.ToByteArray(), 16); Reject(f, "owner-class-guid", "wrong-type"); });
        Test("empty anchor class is incomplete proof", () =>
        { var f = Fixture.VendorUsb(); f.Nodes[2].Class = Guid.Empty; Reject(f, "owner-class-guid", "malformed"); });
        Test("property CONFIGRET is retained without identity strings", () =>
        {
            var f = new Fixture(); f.Overrides[(1, false, 2)] = (37, 7, [], 0);
            var p = Probe(f); Require(p.Diagnostic is { Stage: "owner-hardware-ids", Reason: "api-failed", NativeResult: 37, PropertyType: 7, PropertyLength: 0 });
            var json = System.Text.Json.JsonSerializer.Serialize(p.Diagnostic); Require(!json.Contains("secret", StringComparison.OrdinalIgnoreCase) && !json.Contains("VID_", StringComparison.Ordinal));
        });
        Test("missing class hardware service bus and enumerator remain rejected", () =>
        {
            foreach (var property in new uint[] { 9, 2, 5 }) { var f = new Fixture(); f.Overrides[(1, false, property)] = (37, 0, [], 0); Require(!Probe(f).Verified); }
            foreach (var property in new uint[] { 21, 24 }) { var f = new Fixture(); f.Overrides[(1, true, property)] = (37, 0, [], 0); Require(!Probe(f).Verified); }
        });
        Test("malformed UTF16 and missing terminators remain rejected", () =>
        {
            foreach (var bytes in new[] { new byte[] { 0x00, 0xD8, 0, 0 }, Encoding.Unicode.GetBytes("service"), new byte[] { 65, 0, 0 } })
            { var f = new Fixture(); f.Overrides[(1, false, 5)] = (0, 1, bytes, (uint)bytes.Length); Reject(f, "owner-service", "malformed"); }
            var g = new Fixture(); g.Overrides[(1, false, 2)] = String(@"USB\VID_1234&PID_5678", 7); Reject(g, "owner-hardware-ids", "malformed");
        });
        Test("reported out-of-buffer length never decodes padded data", () =>
        { var f = new Fixture(); f.Overrides[(1, false, 2)] = (0, 7, new byte[4], 4096); Reject(f, "owner-hardware-ids", "out-of-bounds"); });
        Test("over-limit property length remains rejected and bounded publicly", () =>
        { var f = new Fixture(); f.Overrides[(1, false, 2)] = (0, 7, new byte[4096], 4097); var p = Probe(f); Require(!p.Verified && p.Diagnostic?.PropertyLength is null && p.Diagnostic?.Reason == "out-of-bounds"); });
        Test("parent failure preserves CONFIGRET", () =>
        { var f = Fixture.VendorUsb(); f.ParentResult = 13; var p = Probe(f); Require(!p.Verified && p.Diagnostic is { Stage: "owner-parent", NativeResult: 13 }); });
        Test("parent cycle stops without searching", () =>
        { var f = Fixture.VendorUsb(); f.Parents[1] = 1; Reject(f, "owner-parent", "cycle"); Require(f.ParentCalls.Count == 1); });
        Test("parent edge drift within snapshot is rejected", () =>
        { var f = Fixture.VendorUsb(); f.OnParent = calls => { if (calls == 2) f.Parents[1] = 3; }; Reject(f, "owner-parent", "changed"); });
        Test("anchor instance replacement between reads is rejected", () =>
        { var f = Fixture.VendorUsb(); f.OnLocate = reads => { if (reads == 2) f.Nodes[2].Id = @"USB\VID_1234&PID_5678\replacement-serial"; }; Reject(f, "owner-repeat", "changed"); });
        Test("MEDIA service or hardware replacement between reads is rejected", () =>
        {
            foreach (var property in new[] { "service", "hardware" })
            { var f = Fixture.VendorUsb(); f.OnLocate = reads => { if (reads == 2) { if (property == "service") f.Nodes[1].Service = "replacement"; else f.Nodes[1].Hardware = [@"VENDORBUS\Replacement"]; } }; Reject(f, "owner-repeat", "changed"); }
        });
        Test("MEDIA replacement cannot reuse DEVINST", () =>
        { var f = Fixture.VendorUsb(); f.OnLocate = reads => { if (reads == 2) f.Nodes[1].Id = @"VENDORBUS\Audio\replacement"; }; Reject(f, "owner-device-id", "mismatch"); });
        Test("within-node MEDIA or anchor replacement cannot mix identity and properties", () =>
        {
            foreach (var target in new uint[] { 1, 2 })
            { var f = Fixture.VendorUsb(); f.OnStatus = node => { if (node == target) f.Nodes[node].Id += "-replacement"; }; Reject(f, "owner-device-id", "changed"); Require(f.Reads == 1); }
        });
        Test("topology adapter drift with same owner is rejected", () =>
        { var f = new Fixture(); f.Topology.AdapterForRead = read => read == 1 ? "adapter-id" : "replacement-adapter"; Reject(f, "owner-repeat", "changed"); });
        Test("topology HRESULT and release failure are retained", () =>
        {
            var f = new Fixture(); f.Topology.ActivateResult = unchecked((int)0x80004005); var p = Probe(f); Require(p.Diagnostic is { Stage: "topology-activate", Hresult: unchecked((int)0x80004005) });
            f = new Fixture(); f.Topology.ReleaseFails = true; Reject(f, "topology-release", "release-failed");
        });
        Test("stopped MEDIA or anchor blocks acquisition", () =>
        { foreach (var node in new uint[] { 1, 2 }) { var f = Fixture.VendorUsb(); f.Nodes[node].Status = 0; Reject(f, "owner-status", "not-started"); } });
        Test("restore waives started only and keeps identical fingerprint", () =>
        { var f = Fixture.VendorUsb(); var first = Probe(f); f.Nodes[1].Status = 0; f.Nodes[2].Status = 0; var restored = Probe(f, false); Require(restored.Verified && restored.PhysicalIdentity == first.PhysicalIdentity); });
        Test("restore still rejects status failure or problem", () =>
        { var f = Fixture.VendorUsb(); f.Nodes[2].StatusResult = 13; Reject(f, "owner-status", "api-failed", false); f.Nodes[2].StatusResult = 0; f.Nodes[2].Status = 0x400; Reject(f, "owner-status", "has-problem", false); });
        Test("restore fingerprint changes for MEDIA anchor bus and hardware", () =>
        {
            var baseline = Probe(Fixture.VendorUsb(), false).PhysicalIdentity;
            foreach (var mutation in new Action<Fixture>[] { f => f.Nodes[1].Service = "changed", f => f.Nodes[1].Bus = new("23232323-2323-2323-2323-232323232323"), f => f.Nodes[1].Hardware = [@"VENDORBUS\Changed"], f => f.Nodes[2].Id = @"USB\VID_1234&PID_5678\changed" })
            { var f = Fixture.VendorUsb(); mutation(f); var p = Probe(f, false); Require(p.Verified && p.PhysicalIdentity != baseline); }
        });
        return count;
    }
    private static (uint Result, uint Type, byte[] Bytes, uint Length) String(string value, uint type, bool multi = false)
    { var bytes = Encoding.Unicode.GetBytes(value + (multi ? "\0\0" : "\0")); return (0, type, bytes, (uint)bytes.Length); }
    private sealed record Node
    {
        internal string Id { get; set; } = "";
        internal Guid Class { get; set; } = Media;
        internal string Enumerator { get; set; } = "USB";
        internal Guid Bus { get; set; } = Usb;
        internal string[] Hardware { get; set; } = [];
        internal string Service { get; set; } = "vendor-service";
        internal uint Status { get; set; } = 8;
        internal uint StatusResult { get; set; }
        internal static Node UsbNode() => new() { Id = @"USB\VID_1234&PID_5678\secret-serial", Hardware = [@"USB\VID_1234&PID_5678&REV_0100", @"USB\VID_1234&PID_5678"] };
        internal static Node VendorNode() => new() { Id = @"VENDORBUS\Audio\secret-child", Enumerator = "VENDORBUS", Bus = Vendor, Hardware = [@"VENDORBUS\CustomAudio"] };
        internal static Node PciNode() => new() { Id = @"PCI\VEN_8086&DEV_1234\controller", Enumerator = "PCI", Bus = Pci, Hardware = [@"PCI\VEN_8086&DEV_1234&SUBSYS_00000000"], Class = new("4d36e97d-e325-11ce-bfc1-08002be10318") };
    }
    private sealed class Fixture : IPhysicalOriginalDeviceApi
    {
        internal readonly Dictionary<uint, Node> Nodes = new() { [1] = Node.UsbNode() };
        internal readonly Dictionary<uint, uint> Parents = [];
        internal readonly Dictionary<(uint Node, bool Unified, uint Property), (uint Result, uint Type, byte[] Bytes, uint Length)> Overrides = [];
        internal readonly List<uint> ParentCalls = [];
        internal readonly TopologyFixture Topology;
        internal int Reads;
        internal uint ParentResult;
        internal Action<int>? OnLocate, OnParent;
        internal Action<uint>? OnStatus;
        internal Fixture() { Topology = new(this); }
        internal static Fixture VendorUsb() { var f = new Fixture(); f.Nodes[1] = Node.VendorNode(); f.Nodes[2] = Node.UsbNode(); f.Parents[1] = 2; return f; }
        internal static Fixture HdAudio()
        { var f = new Fixture(); f.Nodes[1] = new() { Id = @"HDAUDIO\FUNC_01&VEN_10DE&DEV_009F\codec", Enumerator = "HDAUDIO", Bus = Vendor, Hardware = [@"HDAUDIO\FUNC_01&VEN_10DE&DEV_009F&SUBSYS_00000000"] }; f.Nodes[2] = Node.PciNode(); f.Parents[1] = 2; return f; }
        public (uint Result, uint Node) Locate(string id) { Reads++; OnLocate?.Invoke(Reads); return (0, 1); }
        public (uint Result, uint Node) Parent(uint node)
        { ParentCalls.Add(node); OnParent?.Invoke(ParentCalls.Count); return ParentResult != 0 ? (ParentResult, 0u) : Parents.TryGetValue(node, out var parent) ? (0u, parent) : (13u, 0u); }
        public (uint Result, string InstanceId) DeviceId(uint node) => (0, Nodes[node].Id);
        public (uint Result, uint Status) Status(uint node)
        { var value = (Nodes[node].StatusResult, Nodes[node].Status); OnStatus?.Invoke(node); return value; }
        public (uint Result, uint Type, byte[] Bytes, uint Length) Property(uint node, uint property)
        {
            if (Overrides.TryGetValue((node, false, property), out var value)) return value;
            var n = Nodes[node];
            return property switch { 9 => String(n.Class.ToString("B"), 1), 2 => String(string.Join('\0', n.Hardware), 7, true), 5 => String(n.Service, 1), _ => throw new Exception("Unexpected legacy property identifier") };
        }
        public (uint Result, uint Type, byte[] Bytes, uint Length) DeviceProperty(uint node, uint property)
        {
            if (Overrides.TryGetValue((node, true, property), out var value)) return value;
            var n = Nodes[node];
            return property switch { 21 => (0, 13, n.Bus.ToByteArray(), 16), 24 => String(n.Enumerator, 18), _ => throw new Exception("Unexpected unified property identifier") };
        }
    }
    private sealed class TopologyFixture(Fixture fixture) : IEndpointTopologyApi
    {
        internal readonly List<string> DeviceIds = [];
        internal readonly List<IntPtr> Released = [];
        internal bool ReleaseFails;
        internal int ActivateResult;
        internal Func<int, string> AdapterForRead = _ => "adapter-id";
        private int reads;
        private string adapter = "";
        private static void Require(bool value) { if (!value) throw new Exception("Incorrect topology ownership contract"); }
        public (int Result, IntPtr Handle) Enumerator() { reads++; return (0, new(1)); }
        public (int Result, IntPtr Handle) Device(IntPtr parent, string id)
        { Require(parent == new IntPtr(1)); DeviceIds.Add(id); if (id == EndpointId) return (0, new(2)); Require(id == adapter && !string.IsNullOrEmpty(adapter)); return (0, new(5)); }
        public (int Result, IntPtr Handle) Topology(IntPtr device) { Require(device == new IntPtr(2)); return (ActivateResult, new(3)); }
        public (int Result, uint Count) ConnectorCount(IntPtr value) { Require(value == new IntPtr(3)); return (0, 1); }
        public (int Result, IntPtr Handle) Connector(IntPtr value) { Require(value == new IntPtr(3)); return (0, new(4)); }
        public (int Result, bool Connected) Connected(IntPtr value) { Require(value == new IntPtr(4)); return (0, true); }
        public (int Result, string Id) ConnectedDeviceId(IntPtr value) { Require(value == new IntPtr(4)); adapter = AdapterForRead(reads); return (0, adapter); }
        public (int Result, IntPtr Handle) Properties(IntPtr value) { Require(value == new IntPtr(5)); return (0, new(6)); }
        public (int Result, string Id) InstanceId(IntPtr value) { Require(value == new IntPtr(6)); return (0, fixture.Nodes[1].Id); }
        public void Release(IntPtr value) { Released.Add(value); if (ReleaseFails) throw new COMException("private release message"); }
    }
}
