// Windows-only activation adapter. Merely compiling/loading this source does not activate anything.
// Official contract: IApplicationActivationManager::ActivateApplication, AO_NONE.
// Short-lived callers use CLSCTX_LOCAL_SERVER so argument lifetime is owned by Windows.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Folia.SpotifyDesktop
{
    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);

        [PreserveSig]
        int ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            out uint processId);
    }

    public static class AppActivation
    {
        private const uint CLSCTX_LOCAL_SERVER = 0x4;
        private const uint COINIT_APARTMENTTHREADED = 0x2;
        private const int RPC_E_CHANGED_MODE = unchecked((int)0x80010106);
        private static readonly Guid ActivationManagerClass = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");
        private static readonly Guid ActivationManagerInterface = new Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D");

        [DllImport("ole32.dll", ExactSpelling = true)]
        private static extern int CoInitializeEx(IntPtr reserved, uint coInit);

        [DllImport("ole32.dll", ExactSpelling = true)]
        private static extern void CoUninitialize();

        [DllImport("ole32.dll", ExactSpelling = true)]
        private static extern int CoCreateInstance(
            ref Guid classId, IntPtr outerUnknown, uint classContext,
            ref Guid interfaceId, out IntPtr instance);

        public static uint Activate(string appUserModelId, string appDirectory)
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("Windows activation is unavailable.");
            if (appUserModelId == null || !Regex.IsMatch(appUserModelId,
                @"\ASpotifyAB\.SpotifyMusic_zpdnekdrzrea0![A-Za-z0-9][A-Za-z0-9._-]{0,63}\z"))
                throw new ArgumentException("The Spotify application identity is invalid.");
            if (String.IsNullOrWhiteSpace(appDirectory) || appDirectory.IndexOfAny(new char[] { '"', '\r', '\n', '\0' }) >= 0)
                throw new ArgumentException("The private AppX directory is invalid.");
            string expected = Path.GetFullPath(appDirectory);
            if (!String.Equals(Path.GetFullPath(appDirectory).TrimEnd('\\'),
                               Path.GetFullPath(expected).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Only this observer's fixed AppX directory is allowed.");
            // One app-specific argument. No shell, protocol URL, alias or arbitrary flags.
            string arguments = "--minimized --app-directory=\"" + expected + "\"";
            int initialized = CoInitializeEx(IntPtr.Zero, COINIT_APARTMENTTHREADED);
            bool balanceInitialization = initialized == 0 || initialized == 1;
            if (initialized < 0 && initialized != RPC_E_CHANGED_MODE)
                throw new COMException("Windows COM initialization failed.", initialized);

            IntPtr pointer = IntPtr.Zero;
            IApplicationActivationManager manager = null;
            try
            {
                Guid classId = ActivationManagerClass;
                Guid interfaceId = ActivationManagerInterface;
                int created = CoCreateInstance(ref classId, IntPtr.Zero, CLSCTX_LOCAL_SERVER, ref interfaceId, out pointer);
                if (created != 0 || pointer == IntPtr.Zero)
                    throw new COMException("Windows application activation manager is unavailable.", created);
                manager = (IApplicationActivationManager)Marshal.GetObjectForIUnknown(pointer);
                uint processId;
                int activated = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
                if (activated != 0 || processId == 0)
                    throw new COMException("Spotify package activation was not confirmed.", activated);
                return processId;
            }
            finally
            {
                try
                {
                    if (manager != null && Marshal.IsComObject(manager))
                        Marshal.FinalReleaseComObject(manager);
                }
                finally
                {
                    if (pointer != IntPtr.Zero) Marshal.Release(pointer);
                    if (balanceInitialization) CoUninitialize();
                }
            }
        }
    }
}

