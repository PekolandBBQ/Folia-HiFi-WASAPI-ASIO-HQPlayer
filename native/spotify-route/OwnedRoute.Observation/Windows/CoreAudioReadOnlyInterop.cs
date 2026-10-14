using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Folia.RouteObservation.Windows;

// Getter and notification-registration slots only. No policy, volume, stream,
// default-device, format, or other device-setting interface is declared here.
[SupportedOSPlatform("windows")]
internal static class CoreAudioReadOnlyInterop
{
    internal static readonly Guid EnumeratorClass = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    internal static readonly Guid EnumeratorInterface = new("A95664D2-9614-4F35-A746-DE8DB63617E6");
    internal static readonly Guid SessionManagerInterface = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    internal static readonly Guid SessionControl2Interface = new("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D");

    [DllImport("ole32.dll", ExactSpelling = true)]
    internal static extern int CoInitializeEx(IntPtr reserved, uint coInit);
    [DllImport("ole32.dll", ExactSpelling = true)]
    internal static extern void CoUninitialize();
    [DllImport("ole32.dll", ExactSpelling = true)]
    internal static extern int CoCreateInstance(in Guid classId, IntPtr outer, uint context,
        in Guid interfaceId, out IntPtr value);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int EnumerateDevices(IntPtr self, int flow, uint states, out IntPtr collection);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int GetDevice(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr device);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int GetPointer(IntPtr self, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int GetUInt32(IntPtr self, out uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int GetInt32(IntPtr self, out int value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int GetGuid(IntPtr self, out Guid value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int DeviceItem(IntPtr self, uint index, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int SessionItem(IntPtr self, int index, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int Activate(IntPtr self, in Guid interfaceId, uint context,
        IntPtr activationParameters, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int NotificationRegistration(IntPtr self, IntPtr notification);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    internal delegate int HResultOnly(IntPtr self);

    internal static T Slot<T>(IntPtr instance, int slot) where T : Delegate
    {
        if (instance == IntPtr.Zero) throw new InvalidDataException("CORE_AUDIO_NULL_COM_POINTER");
        return Marshal.GetDelegateForFunctionPointer<T>(
            Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), checked(slot * IntPtr.Size)));
    }

    internal static void Check(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    internal static void Release(ref IntPtr pointer)
    {
        var owned = pointer;
        pointer = IntPtr.Zero;
        if (owned != IntPtr.Zero) Marshal.Release(owned);
    }

    internal static string OwnedString(IntPtr instance, int slot)
    {
        IntPtr value = IntPtr.Zero;
        try
        {
            Check(Slot<GetPointer>(instance, slot)(instance, out value));
            if (value == IntPtr.Zero) throw new InvalidDataException("CORE_AUDIO_NULL_ID");
            // IDs are opaque: neither normalize nor parse them.
            for (var length = 0; length <= 32768; length++)
            {
                if (Marshal.ReadInt16(value, checked(length * sizeof(char))) != 0) continue;
                if (length == 0) throw new InvalidDataException("CORE_AUDIO_EMPTY_ID");
                return Marshal.PtrToStringUni(value, length)!;
            }
            throw new InvalidDataException("CORE_AUDIO_ID_LIMIT");
        }
        finally
        {
            if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value);
        }
    }
}

// The callback contracts must be COM-visible; all pointer parameters are borrowed
// for the callback duration. Only OnSessionCreated explicitly AddRefs its input.
[ComVisible(true), Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IReadOnlyEndpointNotificationCallback
{
    [PreserveSig] int OnDeviceStateChanged(IntPtr deviceId, uint newState);
    [PreserveSig] int OnDeviceAdded(IntPtr deviceId);
    [PreserveSig] int OnDeviceRemoved(IntPtr deviceId);
    [PreserveSig] int OnDefaultDeviceChanged(int flow, int role, IntPtr defaultDeviceId);
    [PreserveSig] int OnPropertyValueChanged(IntPtr deviceId, ReadOnlyPropertyKey key);
}

[StructLayout(LayoutKind.Sequential)]
public struct ReadOnlyPropertyKey
{
    public Guid FormatId;
    public uint PropertyId;
}

[ComVisible(true), Guid("641DD20B-4D41-49CC-ABA3-174B9477BB08"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IReadOnlySessionCreatedCallback
{
    [PreserveSig] int OnSessionCreated(IntPtr newSession);
}

[ComVisible(true), Guid("24918ACC-64B3-37C1-8CA9-74A66E9957A8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IReadOnlySessionEventsCallback
{
    [PreserveSig] int OnDisplayNameChanged(IntPtr displayName, IntPtr eventContext);
    [PreserveSig] int OnIconPathChanged(IntPtr iconPath, IntPtr eventContext);
    [PreserveSig] int OnSimpleVolumeChanged(float newVolume, int newMute, IntPtr eventContext);
    [PreserveSig] int OnChannelVolumeChanged(uint channelCount, IntPtr newChannelVolumeArray,
        uint changedChannel, IntPtr eventContext);
    [PreserveSig] int OnGroupingParamChanged(IntPtr groupingId, IntPtr eventContext);
    [PreserveSig] int OnStateChanged(int newState);
    [PreserveSig] int OnSessionDisconnected(int disconnectReason);
}
