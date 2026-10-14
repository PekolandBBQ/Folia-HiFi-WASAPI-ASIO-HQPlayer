using System.Runtime.InteropServices;

namespace Folia.Capture;

// ABI follows Microsoft's Audioclient.h. All HRESULTs are preserved and explicitly checked.
// IUnknown's three slots are implicit; the 12+3+3 inherited methods must stay in this order.
[ComImport, Guid("7ED4EE07-8E67-4CD4-8C1A-2B7A5987AD42"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient3Native
{
    [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    [PreserveSig] int IsOffloadCapable(int category, [MarshalAs(UnmanagedType.Bool)] out bool capable);
    [PreserveSig] int SetClientProperties(ref NativeAudioClientProperties properties);
    [PreserveSig] int GetBufferSizeLimits(IntPtr format, [MarshalAs(UnmanagedType.Bool)] bool eventDriven, out long minimum, out long maximum);
    [PreserveSig] int GetSharedModeEnginePeriod(IntPtr format, out uint normal, out uint fundamental, out uint minimum, out uint maximum);
    [PreserveSig] int GetCurrentSharedModeEnginePeriod(out IntPtr format, out uint period);
    [PreserveSig] int InitializeSharedAudioStream(uint flags, uint period, IntPtr format, ref Guid sessionGuid);
}

[StructLayout(LayoutKind.Sequential)]
internal struct NativeAudioClientProperties
{
    internal uint Size;
    internal int Offload;
    internal int Category;
    internal uint Options;
}

[ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioRenderClientNative
{
    [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
    [PreserveSig] int ReleaseBuffer(uint frames, uint flags);
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumeratorNative
{
    [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDeviceNative endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDeviceNative endpoint);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceNative
{
    [PreserveSig] int Activate(ref Guid interfaceId, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object client);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
}
