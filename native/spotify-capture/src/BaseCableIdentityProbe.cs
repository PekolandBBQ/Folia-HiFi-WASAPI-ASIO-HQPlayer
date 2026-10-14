using System.Runtime.InteropServices;
using System.Text;

namespace Folia.Capture;

// Bounded standard Configuration Manager reads; no device opens, writes, private IOCTLs or recovery.
internal interface IBaseCableIdentityApi
{
    (uint Result, uint Node) Locate(string instanceId);
    (uint Result, uint Node) Parent(uint node);
    (uint Result, string InstanceId) DeviceId(uint node);
    (uint Result, uint Status) Status(uint node);
    (uint Result, uint Type, byte[] Bytes, uint Length) Property(uint node, uint property);
}

internal static class BaseCableIdentityProbe
{
    internal const int MaxNodes = 4, MaxPropertyBytes = 4096, MaxDeviceIdChars = 200;
    internal const uint HardwareIdsProperty = 2, ServiceProperty = 5, ClassGuidProperty = 9;
    private const uint Started = 8, HasProblem = 0x400;

    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Locate_DevNodeW(out uint node, string instanceId, uint flags);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)]
    private static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_Device_IDW(uint node, [Out] char[] buffer, uint length, uint flags);
    [DllImport("cfgmgr32.dll", ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Status(out uint status, out uint problem, uint node, uint flags);
    [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint CM_Get_DevNode_Registry_PropertyW(uint node, uint property, out uint type,
        [Out] byte[] buffer, ref uint length, uint flags);

    private sealed class ConfigurationManager : IBaseCableIdentityApi
    {
        public (uint Result, uint Node) Locate(string instanceId)
        {
            // NORMAL only: PHANTOM and CANCELREMOVE are deliberately forbidden.
            var result = CM_Locate_DevNodeW(out var node, instanceId, 0);
            return (result, node);
        }
        public (uint Result, uint Node) Parent(uint node)
        {
            var result = CM_Get_Parent(out var parent, node, 0);
            return (result, parent);
        }
        public (uint Result, string InstanceId) DeviceId(uint node)
        {
            var buffer = Enumerable.Repeat('\uffff', MaxDeviceIdChars).ToArray();
            var result = CM_Get_Device_IDW(node, buffer, (uint)buffer.Length, 0);
            var end = Array.IndexOf(buffer, '\0');
            return (result, end > 0 ? new string(buffer, 0, end) : string.Empty);
        }
        public (uint Result, uint Status) Status(uint node)
        {
            // ProblemNumber is defined only when DN_HAS_PROBLEM is set; inspect the flags.
            var result = CM_Get_DevNode_Status(out var status, out _, node, 0);
            return (result, status);
        }
        public (uint Result, uint Type, byte[] Bytes, uint Length) Property(uint node, uint property)
        {
            var buffer = new byte[MaxPropertyBytes]; var length = (uint)buffer.Length;
            var result = CM_Get_DevNode_Registry_PropertyW(node, property, out var type, buffer, ref length, 0);
            return (result, type, buffer, length);
        }
    }

    internal static BaseCableIdentityEvidence Read(string instanceId) => Read(instanceId, new ConfigurationManager());

    // Walk only this endpoint's ancestry. Missing, malformed, ambiguous or truncated evidence never verifies.
    internal static BaseCableIdentityEvidence Read(string instanceId, IBaseCableIdentityApi api)
    {
        if (!ValidId(instanceId)) return new("unavailable", FailureStage: "endpoint-instance-id");
        var stage = "locate";
        try
        {
            var located = api.Locate(instanceId);
            if (located.Result != 0) return Failed(stage, located.Result);
            var seen = new HashSet<uint>(); var node = located.Node;
            for (var depth = 0; depth < MaxNodes; depth++)
            {
                if (!seen.Add(node)) return new("unavailable", FailureStage: "ancestry-cycle");
                stage = "class-guid";
                var property = api.Property(node, ClassGuidProperty);
                if (property.Result != 0) return Failed(stage, property.Result);
                var classText = Decode(property, 1, false);
                if (classText is not { Length: 1 } || !Guid.TryParse(classText[0], out var classGuid))
                    return new("unavailable", FailureStage: stage);
                if (classGuid == BaseCableIdentity.MediaClass)
                {
                    stage = "hardware-ids"; property = api.Property(node, HardwareIdsProperty);
                    if (property.Result != 0) return Failed(stage, property.Result);
                    var hardware = Decode(property, 7, true);
                    if (hardware == null) return new("unavailable", FailureStage: stage);
                    if (hardware.Length != 1 || !string.Equals(hardware[0], BaseCableIdentity.HardwareId, StringComparison.OrdinalIgnoreCase))
                        return new("unsupported", FailureStage: stage);
                    stage = "service"; property = api.Property(node, ServiceProperty);
                    if (property.Result != 0) return Failed(stage, property.Result);
                    var service = Decode(property, 1, false);
                    if (service == null) return new("unavailable", FailureStage: stage);
                    if (service.Length != 1 || !string.Equals(service[0], BaseCableIdentity.Service, StringComparison.OrdinalIgnoreCase))
                        return new("unsupported", FailureStage: stage);
                    stage = "owner-status"; var status = api.Status(node);
                    if (status.Result != 0) return Failed(stage, status.Result);
                    if ((status.Status & Started) == 0 || (status.Status & HasProblem) != 0)
                        return new("unavailable", FailureStage: stage);
                    stage = "owner-instance-id"; var owner = api.DeviceId(node);
                    if (owner.Result != 0) return Failed(stage, owner.Result);
                    if (!ValidId(owner.InstanceId)) return new("unavailable", FailureStage: stage);
                    return new("verified", owner.InstanceId);
                }
                if (depth + 1 == MaxNodes) return new("unavailable", FailureStage: "ancestry-limit");
                stage = "parent"; var parent = api.Parent(node);
                if (parent.Result != 0) return Failed(stage, parent.Result);
                node = parent.Node;
            }
            throw new InvalidOperationException();
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        { return new("unavailable", FailureStage: stage); }
    }

    private static BaseCableIdentityEvidence Failed(string stage, uint result) =>
        new("unavailable", FailureStage: stage, ConfigRet: result);

    private static bool ValidId(string? value) => !string.IsNullOrWhiteSpace(value)
        && value.Length < MaxDeviceIdChars && !value.Any(char.IsControl);

    private static string[]? Decode((uint Result, uint Type, byte[] Bytes, uint Length) property, uint expectedType, bool multiple)
    {
        if (property.Type != expectedType || property.Length > MaxPropertyBytes || property.Length > property.Bytes.Length
            || property.Length < (multiple ? 4 : 2) || (property.Length & 1) != 0) return null;
        string text;
        try { text = new UnicodeEncoding(false, false, true).GetString(property.Bytes, 0, (int)property.Length); }
        catch (DecoderFallbackException) { return null; }
        var terminators = multiple ? 2 : 1;
        if (!text.EndsWith(new string('\0', terminators), StringComparison.Ordinal)) return null;
        var parts = text[..^terminators].Split('\0');
        if (parts.Any(part => string.IsNullOrWhiteSpace(part) || part.Any(char.IsControl))
            || (!multiple && parts.Length != 1)) return null;
        return parts;
    }
}
