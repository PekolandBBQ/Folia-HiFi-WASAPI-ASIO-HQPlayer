using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

internal sealed record ProductChildOutcome(bool Exited,bool Killed,bool TerminalValidated,bool RecoveryRequired,int? ExitCode,bool NoPolicyWrites=false);

// One actual child for one route lifetime, under a long-lived product parent.
// Owns only that child's Process handle; never kills a name, PID search result,
// descendant tree or another application. All native calls stay in the child.
internal sealed class ProductProcessSupervisor:IProductSupervisorProcess
{
    private readonly Process child;
    private readonly long childStarted;
    private readonly string runId,nonce;
    private ProductRetainedJournalOwner? journalOwner;
    private readonly JournalRootLease root;
    private readonly string journalPath;
    private readonly Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>> sourceBroker;
    private (int Pid,long Started,string Target)? inspected;
    private string? session;
    private int generation;
    private ProductRecoveryBaseline? recoveryBaseline;
    private int recoveryAttempted;
    internal ProductDefaultStatus? TerminalDefaults {get;private set;}
    internal object? RetainedLeaseReceipt
    {
        get
        {
            var baseline=recoveryBaseline;var record=journalOwner?.PreparedRecord;
            return baseline is null||record is null?null:new {leaseId=baseline.LeaseId,session,generation,state="restored",ready=false,
                process=ProcessWire.From(record.CurrentProcess),originalRoles=record.Roles.Where(role=>role.Role is RenderRole.Console or RenderRole.Multimedia).OrderBy(role=>role.Role).Select(role=>new OriginalRole((int)role.Role,role.Original)).ToArray(),
                captureDeviceId=baseline.Selection.CaptureDeviceId,renderDeviceId=baseline.Selection.RenderDeviceId,
                sourceDeviceId=baseline.Source.DeviceId,expectedSourceUri=baseline.Source.TrackUri};
        }
    }
    private readonly SemaphoreSlim commands=new(1,1),writes=new(1,1);
    private readonly CancellationTokenSource stopPump=new();
    private readonly object gate=new();
    private TaskCompletionSource<ServiceReply>? pending;
    private string? pendingId;
    private readonly Task pump,drainErrors;
    private int sequence;
    private bool channelFailed,closed;
    private Task<ProductChildOutcome>? stopping;
    internal static readonly TimeSpan OperationBudget=TimeSpan.FromSeconds(8),CancelGrace=TimeSpan.FromSeconds(2),ExitGrace=TimeSpan.FromSeconds(2);
    private ProductProcessSupervisor(Process child,long childStarted,string runId,string nonce,
        JournalRootLease root,string journalPath,Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>> sourceBroker)
    {
        this.child=child;this.childStarted=childStarted;this.runId=runId;this.nonce=nonce;this.root=root;this.journalPath=journalPath;this.sourceBroker=sourceBroker;
        pump=Task.Run(Pump);drainErrors=Task.Run(DrainErrors);
    }
    internal static async Task<ProductProcessSupervisor> Start(Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>> sourceBroker, CancellationToken cancellationToken)
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("WINDOWS_PRODUCT_SUPERVISOR_REQUIRED");
        // Concrete admission still belongs to the qualified composition. No CLI or
        // incoming request controls executable path, runtime adapter or build gate.
        var root=ProductJournalRootInitializer.Acquire();Process? child=null;
        try
        {
            var executable=Environment.ProcessPath??throw new InvalidOperationException("PRODUCT_IMAGE_REQUIRED");
            if(string.Equals(Path.GetFileNameWithoutExtension(executable),"dotnet",StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("PRODUCT_SINGLE_FILE_HOST_REQUIRED");
            var runId=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));var nonce=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            var journalPath=root.Binding.Bind(Path.Combine(root.Binding.LogicalRoot,Guid.NewGuid().ToString("D")+".jsonl"));
            var start=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
            start.ArgumentList.Add("--product-worker");start.Environment[ProductWorkerRuntime.NonceVariable]=nonce;
            cancellationToken.ThrowIfCancellationRequested();
            child=Process.Start(start)??throw new InvalidOperationException("PRODUCT_WORKER_START_FAILED");_=child.Handle;
            var birth=Supervisor.ProcessBirth(child);
            WindowsJournalHandleTransfer.Authenticate(child,birth,root.Binding.UserSid);
            WindowsProductProcessImage.Require(child.SafeHandle,executable);
            using var parent=Process.GetCurrentProcess();
            var hello=new ProductWorkerStart(runId,nonce,parent.Id,Supervisor.ProcessBirth(parent),executable,root.Binding.UserSid,journalPath,root.Binding);
            using(var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
            {
                timeout.CancelAfter(CancelGrace);
                await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(hello).AsMemory(),timeout.Token).ConfigureAwait(false);
                await child.StandardInput.FlushAsync(timeout.Token).ConfigureAwait(false);
            }
            return new(child,birth,runId,nonce,root,journalPath,sourceBroker);
        }
        catch
        {
            // A failure here cannot have sent any public acquire command. Still
            // reclaim only this started child, then dispose its root/handle owner.
            if(child is not null)
            {
                try {child.StandardInput.Close();if(!await WaitForExit(child,ExitGrace)) {child.Kill();await WaitForExit(child,ExitGrace);}}catch {}
                child.Dispose();
            }
            root.Dispose();throw;
        }
    }
    internal async Task<ServiceReply> Request(string body,CancellationToken cancellationToken)
    {
        if(body.Length>16384)throw new InvalidDataException("PRODUCT_REQUEST_LIMIT");
        await commands.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            using var request=JsonDocument.Parse(body);
            var command=request.RootElement.GetProperty("command").GetString();
            if(command=="acquire")
            {
                var payload=request.RootElement.GetProperty("payload");
                var expected=(payload.GetProperty("expectedSpotifyProcessId").GetInt32(),long.Parse(payload.GetProperty("expectedSpotifyStartTimeUtcTicks").GetString()!,System.Globalization.CultureInfo.InvariantCulture),payload.GetProperty("renderDeviceId").GetString()!);
                if(inspected is null||inspected.Value!=expected||journalOwner is not null)throw new InvalidDataException("PRODUCT_ACQUIRE_INSPECTION_BINDING_MISMATCH");
                session=payload.GetProperty("session").GetString();generation=payload.GetProperty("generation").GetInt32();
                journalOwner=new(root,child,childStarted,runId,journalPath,expected.Item1,expected.Item2,expected.Item3);
            }
            Task<ServiceReply> result;string id;
            lock(gate)
            {
                if(closed||channelFailed||child.HasExited)throw new IOException("PRODUCT_WORKER_UNAVAILABLE");
                id=(++sequence).ToString(System.Globalization.CultureInfo.InvariantCulture);
                pendingId=id;pending=new(TaskCreationOptions.RunContinuationsAsynchronously);result=pending.Task;
            }
            try
            {
                // Recovered dev11 operation bounds include prepared selection.
                using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);timeout.CancelAfter(command switch
                {
                    "acquire" or "release" or "close"=>TimeSpan.FromSeconds(35),
                    "inspect"=>TimeSpan.FromSeconds(15),
                    "authorizeResume" or "authorizePreparedSelection" or "completePreparedSelection" or "armCaptureInterval" or "suspendPaused" or "resumePreparation" or "rebindPreparedSelection" or "holdExternalSelection" or "seekPark" or "seekResumePreparation" or "seekCancelToPaused"=>TimeSpan.FromSeconds(18),
                    _=>OperationBudget
                });
                await Send(new("command",runId,nonce,id,body),timeout.Token).ConfigureAwait(false);
                var response=await result.WaitAsync(timeout.Token).ConfigureAwait(false);
                if(command is "authorizeResume" or "authorizePreparedSelection" or "completePreparedSelection" or "resumePreparation" or "rebindPreparedSelection" or "holdExternalSelection" or "seekResumePreparation")
                    recoveryBaseline=ProductSourceRecoveryScope.Advance(command == "seekResumePreparation" ? "resumePreparation" : command,request.RootElement.GetProperty("payload"),response,recoveryBaseline);
                if(command=="inspect"&&response.Ok&&response.Inspection is JsonElement found)
                {
                    var process=found.GetProperty("process");
                    inspected=(process.GetProperty("pid").GetInt32(),long.Parse(process.GetProperty("startTimeUtcTicks").GetString()!,System.Globalization.CultureInfo.InvariantCulture),found.GetProperty("renderDeviceId").GetString()!);
                }
                return response;
            }
            catch
            {
                // No retry/reapply after an uncertain response. The owner must
                // establish termination then decide whether retained recovery can
                // run with independently verified source pause.
                // Active/readiness commands must report failure promptly so main
                // can first close PCM and stop capture. Retain this owner until
                // its subsequent scoped release/close requests compensation.
                if(command is "acquire" or "release" or "close")await Stop().ConfigureAwait(false);
                throw;
            }
            finally {lock(gate){pending=null;pendingId=null;}}
        }
        finally {commands.Release();}
    }
    private async Task Pump()
    {
        try
        {
            while(!stopPump.IsCancellationRequested)
            {
                var line=await WireInput.ReadLine(child.StandardOutput,128*1024,stopPump.Token).ConfigureAwait(false);
                if(line is null)throw new EndOfStreamException("PRODUCT_WORKER_EOF");
                var frame=JsonSerializer.Deserialize<ProductPipeFrame>(line)??throw new InvalidDataException("PRODUCT_FRAME_REQUIRED");
                if(frame.RunId!=runId||frame.Nonce!=nonce)throw new InvalidDataException("PRODUCT_WORKER_FRAME_BINDING_MISMATCH");
                if(frame.Kind=="prepared")
                {
                    var receipt=frame.Prepared??throw new InvalidDataException("PREPARED_REQUIRED");
                    var baseline=frame.Baseline??throw new InvalidDataException("RECOVERY_BASELINE_REQUIRED");
                    if(recoveryBaseline is not null||!Guid.TryParseExact(baseline.LeaseId,"D",out _)||baseline.GlobalDefaults.Length!=6||baseline.Source.Process!=receipt.Prepared.Record.CurrentProcess||baseline.Selection.RenderDeviceId!=receipt.Prepared.Record.Target.Id)
                        throw new InvalidDataException("RECOVERY_BASELINE_BINDING_MISMATCH");
                    OriginalPolicySafety.RequireRetained(baseline.OriginalDestinations,receipt.Prepared.Record.Roles.OrderBy(role=>role.Role).Select(role=>role.Original).ToArray());
                    recoveryBaseline=baseline with{GlobalDefaults=baseline.GlobalDefaults.ToArray(),OriginalDestinations=baseline.OriginalDestinations!.ToArray()};
                    var hash=(journalOwner??throw new InvalidDataException("UNEXPECTED_PREPARED_BEFORE_ACQUIRE")).AcceptPrepared(receipt);
                    using var ack=new CancellationTokenSource(CancelGrace);
                    await Send(new("prepared-ack",runId,nonce,Hash:hash),ack.Token).ConfigureAwait(false);continue;
                }
                if(frame.Kind=="terminal")
                {
                    var receipt=frame.Terminal??throw new InvalidDataException("TERMINAL_REQUIRED");
                    (journalOwner??throw new InvalidDataException("UNEXPECTED_TERMINAL_BEFORE_ACQUIRE")).AcceptTerminal(receipt);
                    TerminalDefaults=ValidateDefaultStatus(frame.Defaults);
                    using var ack=new CancellationTokenSource(CancelGrace);
                    await Send(new("terminal-ack",runId,nonce,Hash:receipt.Terminal.FrameHash),ack.Token).ConfigureAwait(false);continue;
                }
                if(frame.Kind=="source")
                {
                    var source=frame.Source??throw new InvalidDataException("SOURCE_REQUEST_REQUIRED");
                    if(source.RequestId!=frame.RequestId||source.Session!=session||source.Generation!=generation||inspected is null||source.Target.Process.Pid!=inspected.Value.Pid||source.Target.Process.StartTimeUtcTicks!=inspected.Value.Started)
                        throw new InvalidDataException("SOURCE_REQUEST_SCOPE_MISMATCH");
                    using var bound=new CancellationTokenSource(TimeSpan.FromSeconds(source.Action=="read"?5:11));
                    ProductPipeFrame answer;
                    try {var state=await sourceBroker(source,bound.Token).ConfigureAwait(false);answer=new("source-reply",runId,nonce,source.RequestId,JsonSerializer.Serialize(state));}
                    catch(Exception e) {answer=new("source-reply",runId,nonce,source.RequestId,Error:e.Message);}
                    using var replyDeadline=new CancellationTokenSource(CancelGrace);
                    await Send(answer,replyDeadline.Token).ConfigureAwait(false);continue;
                }
                if(frame.Kind!="reply"||frame.Body is null)throw new InvalidDataException("PRODUCT_UNEXPECTED_FRAME");
                var reply=JsonSerializer.Deserialize<ServiceReply>(frame.Body,WireJson.Options)??throw new InvalidDataException("PRODUCT_REPLY_REQUIRED");
                lock(gate)
                {
                    if(pending is null||pendingId!=frame.RequestId||!pending.TrySetResult(reply))throw new InvalidDataException("PRODUCT_UNEXPECTED_REPLY");
                }
            }
        }
        catch(Exception e)
        {
            lock(gate){channelFailed=true;pending?.TrySetException(e);}
            try {child.StandardInput.Close();}catch{}
        }
    }
    private async Task Send(ProductPipeFrame frame,CancellationToken cancellationToken)
    {
        await writes.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await child.StandardInput.WriteLineAsync(JsonSerializer.Serialize(frame).AsMemory(),cancellationToken).ConfigureAwait(false);
            await child.StandardInput.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally {writes.Release();}
    }
    private async Task DrainErrors()
    {
        // Bound diagnostics per worker lifetime. Nothing is forwarded as authority.
        var buffer=new char[1024];var count=0;
        try
        {
            while(await child.StandardError.ReadAsync(buffer.AsMemory(),stopPump.Token).ConfigureAwait(false) is var size&&size>0)
            {
                count+=size;if(count>64*1024)throw new IOException("PRODUCT_STDERR_LIMIT");
            }
        }
        catch(Exception e) {lock(gate){channelFailed=true;pending?.TrySetException(e);}try{child.StandardInput.Close();}catch{}}
    }
    internal Task<ProductChildOutcome> Stop()
    {
        // Request timeout, public cleanup, recovery and disposal all converge
        // here. They share one cancel/grace/kill attempt and its exact outcome;
        // an unconfirmed exit must not silently start another grace window.
        lock(gate)return stopping??=StopCore();
    }
    private async Task<ProductChildOutcome> StopCore()
    {
        lock(gate)closed=true;
        var killed=false;
        if(!child.HasExited)
        {
            try {using var timeout=new CancellationTokenSource(CancelGrace);await Send(new("cancel",runId,nonce),timeout.Token).ConfigureAwait(false);}catch{}
            // Keep the duplex channel alive during grace: compensation still
            // needs exact-source pause replies and terminal acceptance ACKs.
            if(!await WaitForExit(child,TimeSpan.FromSeconds(18)).ConfigureAwait(false))
            {
                try {child.StandardInput.Close();}catch{}
                try {if(Supervisor.ProcessBirth(child)!=childStarted)throw new IOException("PRODUCT_CHILD_INSTANCE_CHANGED");child.Kill();killed=true;}catch{}
                await WaitForExit(child,ExitGrace).ConfigureAwait(false);
            }
        }
        var exited=child.HasExited;var terminal=journalOwner?.TerminalValidated??false;
        if(exited)journalOwner?.SealLateObservations();
        // A kill, normal exit code or idle timeout never substitutes for terminal
        // journal proof. Retained state remains held for a future recovery import.
        return new(exited,killed,terminal,journalOwner?.MayHavePolicyWrites==true&&!terminal,exited?child.ExitCode:null,exited&&journalOwner?.MayHavePolicyWrites!=true);
    }
    internal async Task<ProductChildOutcome> RecoverOnce()
    {
        var original=await Stop().ConfigureAwait(false);
        if(!original.Exited||original.TerminalValidated||!original.RecoveryRequired)return original;
        if(Interlocked.Exchange(ref recoveryAttempted,1)!=0)throw new JournalUnavailableException("PRODUCT_RECOVERY_ALREADY_ATTEMPTED");
        var baseline=recoveryBaseline??throw new JournalUnavailableException("PRODUCT_RECOVERY_BASELINE_MISSING");
        var owner=journalOwner??throw new JournalUnavailableException("PRODUCT_RECOVERY_OWNER_REQUIRED");
        var executable=Environment.ProcessPath??throw new InvalidOperationException("PRODUCT_IMAGE_REQUIRED");
        var recoveryNonce=Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var info=new ProcessStartInfo(executable){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        info.ArgumentList.Add("--product-recover");info.Environment[ProductWorkerRuntime.NonceVariable]=recoveryNonce;
        using var recovery=Process.Start(info)??throw new InvalidOperationException("PRODUCT_RECOVERY_START_FAILED");
        _=recovery.Handle;var birth=Supervisor.ProcessBirth(recovery);var killed=false;
        using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(36));
        var diagnostics=DrainRecoveryErrors(recovery,limit.Token);
        try
        {
            WindowsJournalHandleTransfer.Authenticate(recovery,birth,root.Binding.UserSid);
            WindowsProductProcessImage.Require(recovery.SafeHandle,executable);
            var import=owner.TransferForSingleRecovery(recovery,birth);
            using var parent=Process.GetCurrentProcess();
            var hello=new ProductWorkerStart(runId,recoveryNonce,parent.Id,Supervisor.ProcessBirth(parent),executable,
                root.Binding.UserSid,journalPath,root.Binding,import,baseline,session,generation);
            await recovery.StandardInput.WriteLineAsync(JsonSerializer.Serialize(hello).AsMemory(),limit.Token).ConfigureAwait(false);
            await recovery.StandardInput.FlushAsync(limit.Token).ConfigureAwait(false);
            while(true)
            {
                var line=await WireInput.ReadLine(recovery.StandardOutput,128*1024,limit.Token).ConfigureAwait(false);
                if(line is null)break;
                var frame=JsonSerializer.Deserialize<ProductPipeFrame>(line)??throw new InvalidDataException("RECOVERY_FRAME_REQUIRED");
                if(frame.RunId!=runId||frame.Nonce!=recoveryNonce)throw new InvalidDataException("RECOVERY_FRAME_BINDING_MISMATCH");
                ProductPipeFrame reply;
                if(frame.Kind=="source")
                {
                    var source=frame.Source??throw new InvalidDataException("RECOVERY_SOURCE_REQUIRED");
                    if(source.Session!=session||source.Generation!=generation||source.Target!=baseline.Source.ForFreshRecovery())throw new InvalidDataException("RECOVERY_SOURCE_BINDING_MISMATCH");
                    using var bound=CancellationTokenSource.CreateLinkedTokenSource(limit.Token);bound.CancelAfter(TimeSpan.FromSeconds(source.Action=="read"?5:11));
                    try {reply=new("source-reply",runId,recoveryNonce,source.RequestId,JsonSerializer.Serialize(await sourceBroker(source,bound.Token).ConfigureAwait(false)));}
                    catch(Exception e){reply=new("source-reply",runId,recoveryNonce,source.RequestId,Error:e.Message);}
                }
                else if(frame.Kind=="terminal")
                {
                    var terminal=frame.Terminal??throw new InvalidDataException("RECOVERY_TERMINAL_REQUIRED");owner.AcceptRecoveryTerminal(terminal);TerminalDefaults=ValidateDefaultStatus(frame.Defaults);
                    reply=new("terminal-ack",runId,recoveryNonce,Hash:terminal.Terminal.FrameHash);
                }
                else throw new InvalidDataException("RECOVERY_UNEXPECTED_FRAME");
                await recovery.StandardInput.WriteLineAsync(JsonSerializer.Serialize(reply).AsMemory(),limit.Token).ConfigureAwait(false);
                await recovery.StandardInput.FlushAsync(limit.Token).ConfigureAwait(false);
            }
            await recovery.WaitForExitAsync(limit.Token).ConfigureAwait(false);
        }
        catch
        {
            try{recovery.StandardInput.Close();}catch{}
            if(!await WaitForExit(recovery,CancelGrace).ConfigureAwait(false))
            {
                try{if(Supervisor.ProcessBirth(recovery)==birth){recovery.Kill();killed=true;}}catch{}
                await WaitForExit(recovery,ExitGrace).ConfigureAwait(false);
            }
        }
        finally {limit.Cancel();try{await diagnostics.WaitAsync(ExitGrace).ConfigureAwait(false);}catch{}}
        var exited=recovery.HasExited;var terminalValid=owner.TerminalValidated&&exited&&recovery.ExitCode==0;
        return new(exited,killed,terminalValid,!terminalValid,exited?recovery.ExitCode:null);
    }
    private ProductDefaultStatus ValidateDefaultStatus(ProductDefaultStatus? status)
    {
        var baseline=recoveryBaseline??throw new JournalUnavailableException("RECOVERY_DEFAULT_BASELINE_REQUIRED");
        if(status is null||status.Frozen.Length!=6||status.Current.Length!=6||!status.Frozen.SequenceEqual(baseline.GlobalDefaults)||
            status.Unchanged!=status.Frozen.SequenceEqual(status.Current))throw new JournalUnavailableException("TERMINAL_DEFAULT_OBSERVATION_INVALID");
        return status with{Frozen=status.Frozen.ToArray(),Current=status.Current.ToArray()};
    }
    private static async Task DrainRecoveryErrors(Process recovery,CancellationToken cancellationToken)
    {
        var buffer=new char[1024];var total=0;
        while(await recovery.StandardError.ReadAsync(buffer.AsMemory(),cancellationToken).ConfigureAwait(false) is var size&&size>0)
            if((total+=size)>64*1024)throw new IOException("RECOVERY_DIAGNOSTIC_LIMIT");
    }
    internal RecoveryJournalImport TransferForSingleRecovery(Process recovery,long birth)
    {
        if(!child.HasExited)throw new JournalUnavailableException("ORIGINAL_CHILD_EXIT_NOT_CONFIRMED");
        return (journalOwner??throw new JournalUnavailableException("PRODUCT_RECOVERY_OWNER_REQUIRED")).TransferForSingleRecovery(recovery,birth);
    }
    private static async Task<bool> WaitForExit(Process process,TimeSpan budget)
    {
        using var timeout=new CancellationTokenSource(budget);
        try {await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);return true;}
        catch(OperationCanceledException){return process.HasExited;}
    }
    Task<ServiceReply> IProductSupervisorProcess.Request(string body,CancellationToken token)=>Request(body,token);
    Task<ProductChildOutcome> IProductSupervisorProcess.Stop()=>Stop();
    Task<ProductChildOutcome> IProductSupervisorProcess.RecoverOnce()=>RecoverOnce();
    ProductDefaultStatus? IProductSupervisorProcess.TerminalDefaults=>TerminalDefaults;
    object? IProductSupervisorProcess.RetainedLeaseReceipt=>RetainedLeaseReceipt;
    private void ReleaseResources(){if(journalOwner is not null)journalOwner.Dispose();else root.Dispose();child.Dispose();stopPump.Dispose();commands.Dispose();writes.Dispose();}
    public async ValueTask DisposeAsync()
    {
        await Stop().ConfigureAwait(false);stopPump.Cancel();
        // These tasks use cancellable pipe IO; do not keep the UI awaiting them.
        var pendingIo=Task.WhenAll(pump,drainErrors);
        try {await pendingIo.WaitAsync(ExitGrace).ConfigureAwait(false);}catch{}
        if(!pendingIo.IsCompleted)
        {
            // A native duplicate may outlive the deadline. Proof is sealed after
            // confirmed exit; let the late operation close its handle before
            // releasing root pins. Do not race disposal against native IO.
            _=pendingIo.ContinueWith(_=>ReleaseResources(),CancellationToken.None,TaskContinuationOptions.ExecuteSynchronously,TaskScheduler.Default);
            return;
        }
        ReleaseResources();
    }
}
