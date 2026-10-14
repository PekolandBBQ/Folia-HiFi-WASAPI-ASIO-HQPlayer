using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace Folia.Capture;

// Windows application loopback selects a process tree, independently of the
// render endpoint's mix. Keep the activation data alive until COM completes.
internal static class ProcessLoopbackActivation
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Activation { public int Type; public uint ProcessId; public int Mode; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct Variant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public uint Size;
        [FieldOffset(16)] public IntPtr Data;
    }
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IOperation
    {
        [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
    }
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICompletion
    {
        [PreserveSig] int ActivateCompleted(IOperation operation);
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    private sealed class Completion : ICompletion
    {
        internal readonly TaskCompletionSource<AudioClient> Result = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int ActivateCompleted(IOperation operation)
        {
            try
            {
                Marshal.ThrowExceptionForHR(operation.GetActivateResult(out var result, out var activated));
                Marshal.ThrowExceptionForHR(result);
                Result.TrySetResult(new AudioClient((IAudioClient)activated));
            }
            catch (Exception error) { Result.TrySetException(error); }
            return 0;
        }
    }
    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int ActivateAudioInterfaceAsync(string path, in Guid iid,
        in Variant parameters, ICompletion completion, out IOperation operation);

    internal static AudioClient Open(int processId)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
            throw new CaptureFailure("PROCESS_CAPTURE_UNSUPPORTED");
        if (processId <= 0) throw new CaptureFailure("INVALID_REQUEST");
        var data = Marshal.AllocCoTaskMem(Marshal.SizeOf<Activation>());
        IOperation? operation = null;
        var completion = new Completion();
        try
        {
            Marshal.StructureToPtr(new Activation { Type = 1, ProcessId = checked((uint)processId), Mode = 0 }, data, false);
            var variant = new Variant { Type = 65, Size = (uint)Marshal.SizeOf<Activation>(), Data = data };
            var iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", in iid, in variant, completion, out operation));
            // The worker owner has a separate startup deadline. COM retains this
            // callback until completion; do not free its activation buffer early.
            return completion.Result.Task.GetAwaiter().GetResult();
        }
        finally
        {
            GC.KeepAlive(completion);
            if (operation is not null) Marshal.ReleaseComObject(operation);
            Marshal.FreeCoTaskMem(data);
        }
    }
}
