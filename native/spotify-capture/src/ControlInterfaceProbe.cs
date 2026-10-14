using System.Runtime.InteropServices;

namespace Folia.Capture;

internal interface IControlInterfaceApi
{
    (IntPtr Set, int Win32Error) CreateSet();
    ControlInterfaceStep Next(IntPtr set, uint index);
    (bool Released, int Win32Error) ReleaseSet(IntPtr set);
}

// Enumerates the original Pack45 panel interface, without requesting paths, opening it, or sending IOCTLs.
internal static class ControlInterfaceProbe
{
    private static readonly Guid BaseCableInterface = new("d657ec7b-e6cc-48c6-9a35-c0f907e5dab9");

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceInterfaceData
    {
        internal uint Size;
        internal Guid InterfaceClassGuid;
        internal uint Flags;
        internal UIntPtr Reserved;
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevsW(in Guid classGuid, string? enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiEnumDeviceInterfaces(IntPtr set, IntPtr device, in Guid classGuid,
        uint index, ref DeviceInterfaceData data);
    [DllImport("setupapi.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    private sealed class SetupApi : IControlInterfaceApi
    {
        public (IntPtr Set, int Win32Error) CreateSet()
        {
            // PRESENT | DEVICEINTERFACE: currently present devices in this observed vendor class.
            var set = SetupDiGetClassDevsW(in BaseCableInterface, null, IntPtr.Zero, 0x12);
            return (set, set == new IntPtr(-1) ? Marshal.GetLastWin32Error() : 0);
        }
        public ControlInterfaceStep Next(IntPtr set, uint index)
        {
            var data = new DeviceInterfaceData { Size = (uint)Marshal.SizeOf<DeviceInterfaceData>() };
            var found = SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, in BaseCableInterface, index, ref data);
            return new(found, data.Flags, found ? 0 : Marshal.GetLastWin32Error());
        }
        public (bool Released, int Win32Error) ReleaseSet(IntPtr set)
        {
            var released = SetupDiDestroyDeviceInfoList(set);
            return (released, released ? 0 : Marshal.GetLastWin32Error());
        }
    }

    internal static ControlInterfaceEvidence Read() => Read(new SetupApi());

    // The injected boundary lets portable tests exercise the real handle/error flow without
    // invoking SetupAPI. It also ensures the handle is released on unexpected exceptions.
    internal static ControlInterfaceEvidence Read(IControlInterfaceApi api)
    {
        IntPtr set = new(-1);
        ControlInterfaceEvidence result = new("unavailable", 0, 0, FailureStage: "load-api");
        try
        {
            var opened = api.CreateSet(); set = opened.Set;
            result = set == new IntPtr(-1)
                ? new("failed", 0, 0, opened.Win32Error, "create-set")
                : ControlInterfaceInventory.Read(index => api.Next(set, index));
        }
        catch (Exception error) when (IsUnavailable(error))
        { result = new("unavailable", 0, 0, FailureStage: "load-api"); }
        finally
        {
            // No device was opened. Release only the information set; preserve any primary
            // enumeration error over cleanup failure, without exception text or paths.
            if (set != new IntPtr(-1))
            {
                try
                {
                    var released = api.ReleaseSet(set);
                    if (!released.Released && result.State is "complete" or "limit")
                        result = result with { State = "failed", Win32Error = released.Win32Error, FailureStage = "release-set" };
                }
                catch (Exception error) when (IsUnavailable(error))
                {
                    if (result.State is "complete" or "limit")
                        result = result with { State = "unavailable", FailureStage = "release-set" };
                }
            }
        }
        return result;
    }

    private static bool IsUnavailable(Exception error) => error is DllNotFoundException
        or EntryPointNotFoundException or BadImageFormatException;
}
