using System;
using System.Runtime.InteropServices;

// OwnedRoute.Native/AppRouteRuntime.cs: select the available per-app routing ABI without policy writes.
namespace Folia.RouteResearch.Native
{
    public static class AppRouteCompatibility
    {
        public const string Profile = "folia-owned-route-runtime-abi-x64-v1";
        public const string DownlevelInterfaceId = "2a59116d-6c4f-45e0-a74f-707e3fef9258";
        public const int NoInterface = unchecked((int)0x80004002);
        public static void RequireClient(uint major, uint minor, uint build, byte productType)
        {
            if (major != 10 || minor != 0 || build < 17134 || productType != 1)
                throw new PlatformNotSupportedException("APP_ROUTE_WINDOWS_UNSUPPORTED");
        }
        // Both published interface layouts use Set=25/Get=26; interface availability decides support.
        public static string SelectInterface(uint build, Func<Guid, int> activate)
        {
            var ids = build >= 22000
                ? new[] { Win11AppRouteAbi.InterfaceId, DownlevelInterfaceId }
                : new[] { DownlevelInterfaceId, Win11AppRouteAbi.InterfaceId };
            foreach (var id in ids)
            {
                int hr = activate(new Guid(id));
                if (hr >= 0) return id;
                if (hr != NoInterface) throw new COMException("APP_ROUTE_ACTIVATION_FAILED", hr);
            }
            throw new PlatformNotSupportedException("APP_ROUTE_INTERFACE_UNAVAILABLE");
        }
    }

    public sealed class AppRouteCapability
    {
        public uint WindowsBuild { get; private set; }
        public string InterfaceId { get; private set; }
        internal AppRouteCapability(uint build, string iid) { WindowsBuild = build; InterfaceId = iid; }
    }

    internal sealed class AppRouteRuntime : IDisposable
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct OsVersion
        {
            public uint Size, Major, Minor, Build, Platform;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
            public ushort ServicePackMajor, ServicePackMinor, SuiteMask;
            public byte ProductType, Reserved;
        }
        [DllImport("ntdll.dll", ExactSpelling = true)] private static extern int RtlGetVersion(ref OsVersion version);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern int RoInitialize(uint mode);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern void RoUninitialize();
        [DllImport("combase.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string value, uint length, out IntPtr result);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern int WindowsDeleteString(IntPtr value);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
        internal IntPtr Factory { get; private set; }
        internal AppRouteCapability Capability { get; private set; }
        private readonly int thread = Environment.CurrentManagedThreadId;
        private bool initialized, disposed;

        internal AppRouteRuntime()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("WINDOWS_REQUIRED");
            if (RuntimeInformation.ProcessArchitecture != Architecture.X64)
                throw new PlatformNotSupportedException("APP_ROUTE_X64_REQUIRED");
            var version = new OsVersion { Size = (uint)Marshal.SizeOf(typeof(OsVersion)) };
            Check(RtlGetVersion(ref version), "APP_ROUTE_VERSION_UNAVAILABLE");
            AppRouteCompatibility.RequireClient(version.Major, version.Minor, version.Build, version.ProductType);
            IntPtr name = IntPtr.Zero;
            try
            {
                Check(RoInitialize(1), "APP_ROUTE_INITIALIZATION_FAILED");
                initialized = true;
                const string runtimeClass = "Windows.Media.Internal.AudioPolicyConfig";
                Check(WindowsCreateString(runtimeClass, (uint)runtimeClass.Length, out name), "APP_ROUTE_CLASS_UNAVAILABLE");
                string iid = AppRouteCompatibility.SelectInterface(version.Build, id =>
                {
                    IntPtr candidate;
                    int hr = RoGetActivationFactory(name, ref id, out candidate);
                    if (hr >= 0 && candidate == IntPtr.Zero) throw new InvalidOperationException("APP_ROUTE_FACTORY_NULL");
                    if (hr < 0 && candidate != IntPtr.Zero) Marshal.Release(candidate);
                    if (hr >= 0) Factory = candidate;
                    return hr;
                });
                Capability = new AppRouteCapability(version.Build, iid);
            }
            catch { Dispose(); throw; }
            finally { if (name != IntPtr.Zero) WindowsDeleteString(name); }
        }
        internal void ProbeReadOnly()
        {
            // Capability discovery has no Spotify session yet. Reads of its actual
            // persisted roles remain in the verified playback/recovery transaction.
            var table = Marshal.ReadIntPtr(Factory);
            if (Marshal.ReadIntPtr(table, Win11AppRouteAbi.SetSlot * IntPtr.Size) == IntPtr.Zero
                || Marshal.ReadIntPtr(table, Win11AppRouteAbi.GetSlot * IntPtr.Size) == IntPtr.Zero)
                throw new InvalidOperationException("APP_ROUTE_INTERFACE_UNAVAILABLE");
        }
        private static void Check(int hr, string code) { if (hr < 0) throw new COMException(code, hr); }
        public void Dispose()
        {
            if (disposed) return;
            if (Environment.CurrentManagedThreadId != thread) throw new InvalidOperationException("APP_ROUTE_THREAD_OWNERSHIP_CHANGED");
            disposed = true;
            if (Factory != IntPtr.Zero) { Marshal.Release(Factory); Factory = IntPtr.Zero; }
            if (initialized) { RoUninitialize(); initialized = false; }
        }
        public static AppRouteCapability Probe()
        {
            using (var runtime = new AppRouteRuntime()) { runtime.ProbeReadOnly(); return runtime.Capability; }
        }
    }

    public static class AppRouteProbe
    {
        public static AppRouteCapability ReadOnly() { return AppRouteRuntime.Probe(); }
    }
}
