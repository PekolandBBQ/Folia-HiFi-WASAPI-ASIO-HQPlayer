using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal sealed record JournalCommitReceipt(RouteRecord Record,long CommittedLength,string FrameHash)
{
    internal static JournalCommitReceipt From(RouteJournalCommit commit)=>new(commit.Record,commit.CommittedLength,commit.FrameHash);
}
internal sealed record PreparedJournalReceipt(string RunId,int ChildPid,long ChildStarted,string UserSid,
    string Path,string FileIdentity,JournalStorageBinding Storage,long HandleValue,JournalCommitReceipt Prepared,bool Fresh);
internal sealed record RoleReadback(RenderRole Role,string? Expected,string? Actual);
internal sealed record TerminalJournalReceipt(string RunId,int ChildPid,long ChildStarted,string UserSid,
    string Path,string FileIdentity,JournalStorageBinding Storage,string PreparedHash,long PreparedLength,
    JournalCommitReceipt Terminal,RoleReadback[] Values);
internal sealed record RecoveryJournalImport(long HandleValue,PreparedJournalReceipt Prepared);
internal sealed record WorkerHandshake(string Nonce,string RunId,int ParentPid,long ParentStarted,string ParentImage,
    string AssemblyPath,JournalStorageBinding? JournalStorage=null,RecoveryJournalImport? Recovery=null);
internal sealed record WorkerCommand(string Kind,string RunId,string Nonce,string? PreparedHash=null);

// Implementations may duplicate ONLY the supplied journal handle. No generic
// handle-import argument is exposed to callers, and every copy is noninheritable.
internal interface IJournalHandleTransfer
{
    SafeFileHandle Retain(Process source,long started,string userSid,long journalHandle);
    long Send(Process destination,long started,string userSid,SafeFileHandle retainedJournal);
}
internal sealed class WindowsJournalHandleTransfer:IJournalHandleTransfer
{
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr destination,out IntPtr copy,uint access,bool inherit,uint options);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetHandleInformation(SafeFileHandle handle,out uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(SafeProcessHandle process,uint access,out SafeAccessTokenHandle token);
    internal static string ProcessSid(Process process)
    {
        if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_HANDLE_TRANSFER_REQUIRED");
        if(!OpenProcessToken(process.SafeHandle,8,out var token)) throw new Win32Exception(Marshal.GetLastWin32Error());
        using(token) using(var identity=new WindowsIdentity(token.DangerousGetHandle()))
            return identity.User?.Value??throw new JournalUnavailableException("PROCESS_SID_UNAVAILABLE");
    }
    internal static void Authenticate(Process process,long started,string sid)
    {
        if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_HANDLE_TRANSFER_REQUIRED");
        if(process.HasExited || Supervisor.ProcessBirth(process)!=started || ProcessSid(process)!=sid)
            throw new JournalUnavailableException("JOURNAL_PROCESS_IDENTITY_CHANGED");
    }
    internal static void ValidateFileHandle(SafeFileHandle handle)
    {
        if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_HANDLE_TRANSFER_REQUIRED");
        if(handle.IsInvalid || handle.IsClosed || GetFileType(handle)!=1 || !GetHandleInformation(handle,out var flags) || (flags&1)!=0)
            throw new JournalUnavailableException("JOURNAL_TRANSFER_HANDLE_INVALID_OR_INHERITABLE");
    }
    public SafeFileHandle Retain(Process source,long started,string userSid,long journalHandle)
    {
        var processHandle=source.SafeHandle;var processPinned=false;
        try
        {
            processHandle.DangerousAddRef(ref processPinned);
            Authenticate(source,started,userSid);
            if(journalHandle<=0 || !DuplicateHandle(processHandle.DangerousGetHandle(),new IntPtr(journalHandle),GetCurrentProcess(),out var raw,0,false,2))
                throw new JournalUnavailableException("JOURNAL_RETAIN_DUPLICATE_FAILED",new Win32Exception(Marshal.GetLastWin32Error()));
            var result=new SafeFileHandle(raw,true);
            try {Authenticate(source,started,userSid);ValidateFileHandle(result);return result;}
            catch {result.Dispose();throw;}
        }
        finally {if(processPinned) processHandle.DangerousRelease();}
    }
    public long Send(Process destination,long started,string userSid,SafeFileHandle retainedJournal)
    {
        var processHandle=destination.SafeHandle;var processPinned=false;var filePinned=false;
        try
        {
            processHandle.DangerousAddRef(ref processPinned);retainedJournal.DangerousAddRef(ref filePinned);
            Authenticate(destination,started,userSid);ValidateFileHandle(retainedJournal);
            if(!DuplicateHandle(GetCurrentProcess(),retainedJournal.DangerousGetHandle(),processHandle.DangerousGetHandle(),out var raw,0,false,2))
                throw new JournalUnavailableException("JOURNAL_RECOVERY_DUPLICATE_FAILED",new Win32Exception(Marshal.GetLastWin32Error()));
            // The destination owns this remote handle even if pipe startup fails;
            // its bounded termination reclaims it, never reopening the file.
            Authenticate(destination,started,userSid);return raw.ToInt64();
        }
        finally
        {
            if(filePinned) retainedJournal.DangerousRelease();
            if(processPinned) processHandle.DangerousRelease();
        }
    }

}

internal sealed class RetainedJournal:IDisposable
{
    private readonly string receiptJson;
    internal PreparedJournalReceipt Receipt=>JsonSerializer.Deserialize<PreparedJournalReceipt>(receiptJson)!;
    internal SafeFileHandle Handle { get; }
    private int originalExited,recoveryClaimed;
    internal void ConfirmOriginalExit(Process process,long birth)
    {
        var receipt=Receipt;
        if(process.Id!=receipt.ChildPid || birth!=receipt.ChildStarted || !process.HasExited)
            throw new JournalUnavailableException("ORIGINAL_CHILD_EXIT_NOT_CONFIRMED");
        Interlocked.Exchange(ref originalExited,1);
    }
    internal void ClaimRecovery()
    {
        if(Volatile.Read(ref originalExited)==0) throw new JournalUnavailableException("ORIGINAL_CHILD_EXIT_NOT_CONFIRMED");
        if(Interlocked.Exchange(ref recoveryClaimed,1)!=0) throw new JournalUnavailableException("ONLY_ONE_RECOVERY_PER_RUN");
    }
    internal RetainedJournal(PreparedJournalReceipt receipt,SafeFileHandle handle)
    { receiptJson=JsonSerializer.Serialize(receipt); Handle=handle; }
    public void Dispose()=>Handle.Dispose();
}

// Exactly one reader owns stdin after the handshake. Both cancellation and the
// Prepared ACK travel through it. All line lengths, ACK waits and failures bound.
internal static class WorkerChannel
{
    private static WorkerHandshake? handshake;
    private static Process? parent;
    private static TaskCompletionSource<string>? pendingAck;
    private static readonly object gate=new();
    private static int controlFailed;
    internal static JournalRootLease? Root { get; private set; }
    internal static PreparedJournalReceipt? Prepared { get; private set; }
    internal static RecoveryJournalImport? Recovery=>handshake?.Recovery;
    internal static string RunId=>handshake?.RunId??throw new JournalUnavailableException("AUTHENTICATED_RUN_REQUIRED");
    internal static async Task<string?> ReadBoundedLineAsync(TextReader reader,int maximum)
    {
        var text=new StringBuilder(); var one=new char[1];
        while(await reader.ReadAsync(one.AsMemory()).ConfigureAwait(false)!=0)
        {
            if(one[0]=='\n') return text.ToString().TrimEnd('\r');
            if(text.Length>=maximum) throw new InvalidDataException("WORKER_CONTROL_LINE_LIMIT");
            text.Append(one[0]);
        }
        if(text.Length!=0) throw new InvalidDataException("WORKER_CONTROL_TRUNCATED");
        return null;
    }
    internal static void Initialize(WorkerHandshake value,Process verifiedParent,JournalRootLease? root)
    {
        handshake=value; parent=verifiedParent; Root=root;
        _=Task.Run(async()=>
        {
            try
            {
                while(true)
                {
                    var line=await ReadBoundedLineAsync(Console.In,4096).ConfigureAwait(false);
                    if(line is null) { Fail(); return; }
                    if(line=="CANCEL") { Worker.RequestCancellation(); continue; }
                    var command=JsonSerializer.Deserialize<WorkerCommand>(line)??throw new InvalidDataException();
                    if(command.RunId!=value.RunId || command.Nonce!=value.Nonce || command.Kind!="PREPARED_ACK" || command.PreparedHash==null)
                        throw new InvalidDataException("WORKER_CONTROL_INVALID");
                    lock(gate)
                    {
                        if(pendingAck==null || !pendingAck.TrySetResult(command.PreparedHash)) throw new InvalidDataException("WORKER_ACK_UNEXPECTED");
                    }
                }
            }
            catch { Fail(); }
        });
    }
    internal static void MarkOutputLost()=>Fail();
    private static void Fail()
    {
        Interlocked.Exchange(ref controlFailed,1); Worker.RequestCancellation();
        lock(gate) pendingAck?.TrySetException(new JournalUnavailableException("PARENT_CONTROL_CHANNEL_LOST"));
    }
    internal static void RequireParentAlive()
    {
        if(Volatile.Read(ref controlFailed)!=0) throw new JournalUnavailableException("PARENT_CONTROL_CHANNEL_LOST");
        var h=handshake??throw new JournalUnavailableException("AUTHENTICATED_RUN_REQUIRED");
        var p=parent??throw new JournalUnavailableException("AUTHENTICATED_PARENT_REQUIRED");
        if(p.HasExited || Supervisor.ProcessBirth(p)!=h.ParentStarted) throw new JournalUnavailableException("PARENT_PROCESS_EXITED");
        if(OperatingSystem.IsWindows()) WindowsJournalHandleTransfer.Authenticate(p,h.ParentStarted,h.JournalStorage!.UserSid);
        Root?.Validate();
    }
    internal static void PublishPrepared(FileRouteJournal journal,JournalGuard guard,JournalRootLease root,RouteJournalCommit commit,bool fresh)
    {
        RequireParentAlive(); root.Validate();
        var h=handshake!;
        using var self=Process.GetCurrentProcess();
        var receipt=journal.WithBorrowedHandle(handle=>new PreparedJournalReceipt(h.RunId,self.Id,Supervisor.ProcessBirth(self),root.Binding.UserSid,
            root.Binding.Bind(RunJournalProof.ArgumentValue(Environment.GetCommandLineArgs(),"--journal")??throw new JournalUnavailableException("JOURNAL_ARGUMENT_REQUIRED")),
            guard.FileIdentity,root.Binding,handle.DangerousGetHandle().ToInt64(),JournalCommitReceipt.From(commit),fresh));
        AwaitPreparedAcknowledgement(receipt);
    }
    internal static void AwaitPreparedAcknowledgement(PreparedJournalReceipt receipt)
    {
        RequireParentAlive();
        lock(gate)
        {
            if(pendingAck!=null || Prepared!=null) throw new JournalUnavailableException("PREPARED_RECEIPT_ALREADY_PUBLISHED");
            pendingAck=new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        Evidence.Emit(receipt.Fresh?"JOURNAL_PREPARED":"EXPLICIT_RESTORE_OPENED",receipt);
        if(!pendingAck.Task.Wait(2_000) || pendingAck.Task.GetAwaiter().GetResult()!=receipt.Prepared.FrameHash)
            throw new JournalUnavailableException("PREPARED_RETAIN_ACK_MISSING_OR_MISMATCHED");
        RequireParentAlive();
        Prepared=JsonSerializer.Deserialize<PreparedJournalReceipt>(JsonSerializer.Serialize(receipt));
    }
    internal static void AdoptRecoveryPrepared(PreparedJournalReceipt receipt)
    {
        RequireParentAlive(); if(receipt.RunId!=RunId || !receipt.Fresh) throw new JournalUnavailableException("RECOVERY_PROVENANCE_INVALID");
        Prepared=JsonSerializer.Deserialize<PreparedJournalReceipt>(JsonSerializer.Serialize(receipt));
    }
    internal static void EmitTerminal(FileRouteJournal journal,JournalGuard guard,RoleReadback[] values)
    {
        RequireParentAlive(); journal.ValidateStorage();
        var prepared=Prepared??throw new JournalUnavailableException("PREPARED_PROVENANCE_REQUIRED");
        var commit=journal.ReadCurrentCommit()??throw new JournalUnavailableException("TERMINAL_COMMIT_REQUIRED");
        RunJournalProof.ValidateTerminalCommit(prepared,JournalCommitReceipt.From(commit),values);
        using var self=Process.GetCurrentProcess();
        Evidence.Emit("JOURNAL_TERMINAL",new TerminalJournalReceipt(RunId,self.Id,Supervisor.ProcessBirth(self),prepared.UserSid,
            prepared.Path,guard.FileIdentity,Root!.Binding,prepared.Prepared.FrameHash,prepared.Prepared.CommittedLength,JournalCommitReceipt.From(commit),values));
        if(!Evidence.OutputAvailable) throw new JournalUnavailableException("TERMINAL_RECEIPT_CHANNEL_LOST");
    }
}
