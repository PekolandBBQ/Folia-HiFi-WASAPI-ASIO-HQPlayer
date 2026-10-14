using System.Runtime.InteropServices;
using Folia.RouteResearch;
using Folia.ProductRoute;

namespace Folia.RouteRunner;

// Six read-only global defaults (render/capture × console/multimedia/comms).
// An absent endpoint is preserved explicitly; a failed getter never means null.
internal static class ProductDefaultEndpoints
{
    internal static bool Unchanged(string?[] frozen, string?[] current)
    {
        if (frozen.Length != 6 || current.Length != 6) throw new RouteBlockedException("DEFAULT_SNAPSHOT_INVALID");
        return frozen.SequenceEqual(current);
    }
    internal static void RequireSafeRenderDefaults(string?[] current, Func<string, EndpointInfo> endpoint)
    {
        if (current.Length != 6) throw new RouteBlockedException("DEFAULT_SNAPSHOT_INVALID");
        RequireSafeRenderPair(current.Take(2).ToArray(),endpoint);
    }
    internal static void RequireSafeRenderPair(string?[] current, Func<string, EndpointInfo> endpoint)
    {
        if(current.Length!=2) throw new RouteBlockedException("DEFAULT_SNAPSHOT_INVALID");
        foreach (var id in current.Distinct())
        {
            // No current default produces no render path. It must not be turned
            // into a fabricated device or prevent exact paused compensation.
            if (id is null) continue;
            var value = endpoint(id);
            if (value.State != 1 || value.Flow != 0 || value.BaseIdentity.State != "unsupported")
                throw new RouteBlockedException("BASE_OR_UNPROVEN_DEFAULT_FEEDBACK_GUARD");
        }
    }
    internal static ProductDefaultStatus Status(string?[] frozen, string?[] current, Func<string, EndpointInfo> endpoint)
    {
        var unchanged = Unchanged(frozen, current);
        try { RequireSafeRenderDefaults(current, endpoint); return new(unchanged, frozen.ToArray(), current.ToArray()); }
        catch (Exception error)
        {
            // Classification risk is reported, not a reason to undo successful
            // paused compensation or pretend that the global default was set.
            return new(unchanged, frozen.ToArray(), current.ToArray(), FeedbackRisk: true,
                FeedbackIssue: error is RouteBlockedException ? error.Message : "CURRENT_DEFAULT_IDENTITY_UNKNOWN");
        }
    }
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("ole32.dll")] private static extern int CoCreateInstance(in Guid cls, IntPtr outer, uint context, in Guid iid, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DefaultFn(IntPtr self, int flow, int role, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int IdFn(IntPtr self, out IntPtr id);
    private static T Method<T>(IntPtr self, int slot) where T : Delegate =>
        Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size));
    private static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    internal static string?[] Read() => Read(2,3);
    internal static string?[] ReadRenderPair() => Read(1,2);
    private static string?[] Read(int flowCount,int roleCount)
    {
        Check(CoInitializeEx(IntPtr.Zero, 0));
        IntPtr enumerator = IntPtr.Zero;
        try
        {
            var cls = new Guid("bcde0395-e52f-467c-8e3d-c4579291692e");
            var iid = new Guid("a95664d2-9614-4f35-a746-de8db63617e6");
            Check(CoCreateInstance(in cls, IntPtr.Zero, 1, in iid, out enumerator));
            if (enumerator == IntPtr.Zero) throw new InvalidDataException("DEFAULT_ENUMERATOR_NULL");
            var values = new string?[flowCount*roleCount];
            for (var flow = 0; flow < flowCount; flow++) for (var role = 0; role < roleCount; role++)
            {
                IntPtr device = IntPtr.Zero, id = IntPtr.Zero;
                try
                {
                    var result = Method<DefaultFn>(enumerator, 4)(enumerator, flow, role, out device);
                    if (result == unchecked((int)0x80070490)) continue; // documented E_NOTFOUND
                    Check(result);
                    if (result != 0 || device == IntPtr.Zero) throw new InvalidDataException("DEFAULT_ENDPOINT_INVALID");
                    Check(Method<IdFn>(device, 5)(device, out id));
                    values[flow * roleCount + role] = AudioReadOnly.ReadString(id, 512);
                }
                finally { if (id != IntPtr.Zero) Marshal.FreeCoTaskMem(id); if (device != IntPtr.Zero) Marshal.Release(device); }
            }
            return values;
        }
        finally { if (enumerator != IntPtr.Zero) Marshal.Release(enumerator); CoUninitialize(); }
    }
}
