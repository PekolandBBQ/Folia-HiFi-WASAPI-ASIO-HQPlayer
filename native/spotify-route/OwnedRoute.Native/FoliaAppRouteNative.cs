// Per-application route operations. C# 7.3, no package references.
// The original Windows 11 layout and Windows 10 variant are selected at runtime.
// Compatibility evidence and actual hardware test scope are recorded separately.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Folia.RouteResearch.Native
{
    public sealed class NativeSpotifyIdentity
    {
        public uint Pid { get; private set; }
        public long StartTimeUtcTicks { get; private set; }
        public string UserSid { get; private set; }
        public string PolicyIdentity { get; private set; }
        public string ImageIdentity { get; private set; }
        public string Distribution { get; private set; }
        public NativeSpotifyIdentity(uint pid, long startTimeUtcTicks, string userSid,
            string policyIdentity, string imageIdentity, string distribution)
        {
            Pid = pid; StartTimeUtcTicks = startTimeUtcTicks; UserSid = userSid;
            PolicyIdentity = policyIdentity; ImageIdentity = imageIdentity; Distribution = distribution;
        }
        public bool Complete()
        {
            return Pid > 0 && Pid <= int.MaxValue && StartTimeUtcTicks > 0 &&
                !String.IsNullOrWhiteSpace(UserSid) && !String.IsNullOrWhiteSpace(PolicyIdentity) &&
                !String.IsNullOrWhiteSpace(ImageIdentity) && !String.IsNullOrWhiteSpace(Distribution);
        }
        public bool Matches(NativeSpotifyIdentity other)
        {
            return other != null && Complete() && other.Complete() && Pid == other.Pid &&
                StartTimeUtcTicks == other.StartTimeUtcTicks && UserSid == other.UserSid &&
                PolicyIdentity == other.PolicyIdentity && ImageIdentity == other.ImageIdentity &&
                Distribution == other.Distribution;
        }
    }

    // Method layout shared by the two identified Windows per-app routing interfaces.
    public static class Win11AppRouteAbi
    {
        public const string InterfaceId = "ab3d4648-e242-459f-b02f-541c70306324";
        public const int SetSlot = 25;
        public const int GetSlot = 26;
        public const int RenderFlow = 0;
        public const string AuditedSourceSha256 = "a8a43d03a700703de8d6e84be7e407947e6f6c80e7b96a91a88813ae5f93571a";
    }

    public sealed class NativeRouteResult
    {
        public int HResult { get; private set; }
        public string Value { get; private set; }
        public NativeRouteResult(int hResult, string value) { HResult = hResult; Value = value; }
    }

    // One exact verified process, one COM thread, one interface. The verifier must
    // independently establish trusted Spotify executable/package, SID and OS policy
    // identity every time. It must not echo these constructor arguments as "proof".
    public sealed class BoundWin11AppRoute : IDisposable
    {
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int SetAppFn(IntPtr self, uint pid, int flow, int role, IntPtr hstring);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int GetAppFn(IntPtr self, uint pid, int flow, int role, out IntPtr hstring);
        [DllImport("combase.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        private static extern int WindowsCreateString(string value, uint length, out IntPtr result);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern int WindowsDeleteString(IntPtr value);
        [DllImport("combase.dll", ExactSpelling = true)] private static extern IntPtr WindowsGetStringRawBuffer(IntPtr value, out uint length);

        private readonly int ownerThread;
        private readonly NativeSpotifyIdentity expected;
        private readonly Func<uint, NativeSpotifyIdentity> verifier;
        private Process process;
        private IntPtr factory;
        private SetAppFn set;
        private GetAppFn get;
        private AppRouteRuntime runtime;
        private bool disposed;

        public BoundWin11AppRoute(NativeSpotifyIdentity expectedIdentity,
            Func<uint, NativeSpotifyIdentity> verifyCurrentSpotify)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("WINDOWS_REQUIRED");
            // This distributed component targets x64; Windows build selection is automatic.
            if (RuntimeInformation.ProcessArchitecture != Architecture.X64)
                throw new PlatformNotSupportedException("APP_ROUTE_X64_REQUIRED");
            if (expectedIdentity == null || !expectedIdentity.Complete() || verifyCurrentSpotify == null)
                throw new ArgumentException("SPOTIFY_IDENTITY_INCOMPLETE");
            ownerThread = Environment.CurrentManagedThreadId;
            expected = expectedIdentity;
            verifier = verifyCurrentSpotify;
            try
            {
                process = Process.GetProcessById(checked((int)expected.Pid));
                // Open and retain the process handle rather than retaining PID alone.
                if (process.Handle == IntPtr.Zero) throw new InvalidOperationException("SPOTIFY_HANDLE_UNAVAILABLE");
                CheckIdentity();
                runtime = new AppRouteRuntime();
                factory = runtime.Factory;
                var table = Marshal.ReadIntPtr(factory);
                set = (SetAppFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, Win11AppRouteAbi.SetSlot * IntPtr.Size), typeof(SetAppFn));
                get = (GetAppFn)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, Win11AppRouteAbi.GetSlot * IntPtr.Size), typeof(GetAppFn));
            }
            catch { ReleaseResources(); disposed = true; throw; }
        }

        public NativeSpotifyIdentity CheckIdentity()
        {
            CheckThread();
            if (process == null || process.HasExited || process.StartTime.ToUniversalTime().Ticks != expected.StartTimeUtcTicks ||
                !expected.Matches(verifier(expected.Pid)))
                throw new InvalidOperationException("SPOTIFY_INSTANCE_CHANGED");
            return expected;
        }
        public NativeRouteResult Get(int role)
        {
            if (role < 0 || role > 2) throw new ArgumentOutOfRangeException("role");
            CheckIdentity();
            IntPtr value = IntPtr.Zero;
            try
            {
                int hr = get(factory, expected.Pid, Win11AppRouteAbi.RenderFlow, role, out value);
                Check(hr, "Get persisted application route"); // Never failure => null.
                string decoded = null;
                if (value != IntPtr.Zero)
                {
                    uint length;
                    IntPtr buffer = WindowsGetStringRawBuffer(value, out length);
                    if (length > 32768 || (buffer == IntPtr.Zero && length != 0))
                        throw new InvalidOperationException("APP_ROUTE_STRING_INVALID");
                    decoded = length == 0 ? null : Marshal.PtrToStringUni(buffer, checked((int)length));
                }
                CheckIdentity();
                return new NativeRouteResult(hr, decoded);
            }
            finally { if (value != IntPtr.Zero) WindowsDeleteString(value); }
        }
        public NativeRouteResult Set(int role, string persistedPolicyValue)
        {
            // Communications is read-only evidence in this bounded experiment.
            if (role != 0 && role != 1) throw new ArgumentOutOfRangeException("role");
            if (persistedPolicyValue != null && (persistedPolicyValue.Length > 32768 || persistedPolicyValue.IndexOf('\0') >= 0))
                throw new ArgumentException("APP_ROUTE_STRING_INVALID");
            CheckIdentity();
            IntPtr value = IntPtr.Zero;
            try
            {
                if (!String.IsNullOrEmpty(persistedPolicyValue))
                    Check(WindowsCreateString(persistedPolicyValue, (uint)persistedPolicyValue.Length, out value), "Create policy value");
                CheckIdentity();
                int hr = set(factory, expected.Pid, Win11AppRouteAbi.RenderFlow, role, value);
                Check(hr, "Set persisted application route");
                CheckIdentity();
                return new NativeRouteResult(hr, persistedPolicyValue);
            }
            finally { if (value != IntPtr.Zero) WindowsDeleteString(value); }
        }
        private static void Check(int result, string operation)
        {
            if (result < 0) throw new COMException(operation + " HRESULT=0x" + unchecked((uint)result).ToString("X8"), result);
        }
        private void CheckThread()
        {
            if (disposed) throw new ObjectDisposedException("BoundWin11AppRoute");
            if (ownerThread != Environment.CurrentManagedThreadId)
                throw new InvalidOperationException("APP_ROUTE_THREAD_OWNERSHIP_CHANGED");
        }
        private void ReleaseResources()
        {
            if (runtime != null) { runtime.Dispose(); runtime = null; }
            factory = IntPtr.Zero;
            if (process != null) { process.Dispose(); process = null; }
            set = null; get = null;
        }
        public void Dispose()
        {
            if (disposed) return;
            CheckThread();
            ReleaseResources();
            disposed = true;
        }
    }
}
