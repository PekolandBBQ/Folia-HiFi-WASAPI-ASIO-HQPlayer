using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Folia.RouteRunner;

// The parent never calls audio policy. Native calls run only in disposable children.
// A timed-out child must be observed exited before one fresh recovery attempt.
internal static class Supervisor
{
    private const string NonceVariable="FOLIA_ROUTE_TRIAL_NONCE";
    private const int WorkerLimitMs=20_000, RecoveryLimitMs=10_000, CancelGraceMs=2_000, ExitGraceMs=2_000;
    private const int PreparationLimitMs=85_000,RoundtripAbsoluteLimitMs=105_000;
    private const int MaximumOutputChars=4*1024*1024,MaximumLineChars=131072;
    internal sealed record Result(int? ExitCode,bool Exited,bool TimedOut,bool Killed,bool OutputLimit,bool CancellationSent,JournalOwnership? CreatedJournal,
        bool TerminalValidated=false,[property:System.Text.Json.Serialization.JsonIgnore] RetainedJournal? Retained=null,bool ProtocolFailure=false);
    internal sealed record HandoffContext(string RunId,Options? Options,JournalStorageBinding? Storage,JournalRootLease? Root,
        IJournalHandleTransfer Transfer,Action<Microsoft.Win32.SafeHandles.SafeFileHandle,string,string>? ValidateForTest=null)
    {
        internal void ValidateHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,string path,string identity)
        {
            if(Root!=null) { using var guard=new JournalGuard(Root,path,false,identity); guard.Validate(handle); }
            else if(ValidateForTest!=null) ValidateForTest(handle,path,identity);
            else throw new InvalidOperationException("RETAINED_JOURNAL_ROOT_LEASE_REQUIRED");
        }
    }
    public static bool ValidateWorkerHandshake(string[] args)
    {
        var stage="initial"; Process? parent=null; JournalRootLease? lease=null;
        try
        {
            if(args.Count(x=>x is "--internal-worker" or "--internal-recover")!=1) return false;
            var nonce=Environment.GetEnvironmentVariable(NonceVariable); Environment.SetEnvironmentVariable(NonceVariable,null);
            if(nonce is null || nonce.Length!=64 || !Console.IsInputRedirected) return false;
            var task=WorkerChannel.ReadBoundedLineAsync(Console.In,MaximumLineChars);
            if(!task.Wait(2_000)) return false;
            var h=JsonSerializer.Deserialize<WorkerHandshake>(task.Result??"");
            if(h is null || h.Nonce!=nonce || !RunJournalProof.ValidHash(h.RunId)) return false;
            stage="parent-open"; parent=Process.GetProcessById(h.ParentPid);
            stage="parent-identity";
            if(parent.HasExited || parent.SessionId!=Process.GetCurrentProcess().SessionId || ProcessBirth(parent)!=h.ParentStarted ||
                !string.Equals(parent.MainModule?.FileName,h.ParentImage,StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(Environment.ProcessPath,h.ParentImage,StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(CurrentAssembly(),h.AssemblyPath,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("PARENT_IDENTITY_MISMATCH");
            _=parent.Handle;
            if(OperatingSystem.IsWindows())
            {
                if(h.JournalStorage==null) throw new InvalidOperationException("PARENT_ROOT_RECEIPT_REQUIRED");
                WindowsJournalHandleTransfer.Authenticate(parent,h.ParentStarted,h.JournalStorage.UserSid);
                lease=JournalStorage.AcquireRoot(h.JournalStorage);
            }
            if(args.Contains("--internal-recover") != (h.Recovery!=null)) throw new InvalidOperationException("RECOVERY_HANDLE_CHANNEL_REQUIRED");
            if(h.Recovery!=null && (h.Recovery.HandleValue<=0 || h.Recovery.Prepared.RunId!=h.RunId || !h.Recovery.Prepared.Fresh))
                throw new InvalidOperationException("RECOVERY_HANDLE_PROVENANCE_INVALID");
            WorkerChannel.Initialize(h,parent,lease); parent=null; lease=null; return true;
        }
        catch(Exception e) { Evidence.Emit("WORKER_HANDSHAKE_REJECTED",new { stage,reason=e.Message }); return false; }
        finally { lease?.Dispose(); parent?.Dispose(); }
    }
    private static string CurrentAssembly() => string.Equals(Path.GetFileNameWithoutExtension(Environment.ProcessPath),"dotnet",StringComparison.OrdinalIgnoreCase)
        ? Path.GetFullPath(Environment.GetCommandLineArgs()[0]) : Environment.ProcessPath ?? "";
    internal static long ProcessBirth(Process process)
    {
        if(OperatingSystem.IsWindows()) return process.StartTime.ToUniversalTime().Ticks;
        // Linux .NET StartTime is derived from wall/boot clocks and can drift between
        // reads. Device-free supervisor tests use the kernel's immutable start tick.
        var stat=File.ReadAllText($"/proc/{process.Id}/stat");
        return long.Parse(stat[(stat.LastIndexOf(')')+2)..].Split(' ')[19],System.Globalization.CultureInfo.InvariantCulture);
    }
    public static int Run(string[] args)
    {
        if(args.Length==1 && args[0] is "--help" or "-h")
        {
            Console.WriteLine("Folia bounded snapshot route trial A. Default --preflight is read-only.\n"+
                "Roundtrip requires exact --pid, --expected-start-time-utc-ticks, --target, --original-endpoint, fresh --journal, --reviewed-build, --abi-review and all UI attestations including --attest-short-ui-play.\n"+
                "FIRST_READY begins readonly preparation: external Play by +60s, application cutoff +65s, actual Play-to-Pause <=30s, absolute Pause +90s. The tool never controls playback.\n"+
                "Observes only the selected PID in partial session snapshots; never proves complete routing or Folia Ready.\n"+
                "Mutating runs return 5 after policy restoration, even when target/return observations exist; never full-success 0.\n"+
                "Explicit --restore requires an existing journal and exact live identity. Read README before use.");
            return 0;
        }
        JournalRootLease? root=null;
        try
        {
            return RunWithStorage(args,OperatingSystem.IsWindows()?()=> (root=JournalStorage.AcquireRoot()).Binding:null,
                (boundArgs,options)=>RunBoundAsync(boundArgs,options,root).GetAwaiter().GetResult());
        }
        finally { root?.Dispose(); }
    }
    internal static int RunWithStorage(string[] args,Func<JournalStorageBinding>? resolve,Func<string[],Options,int> start)
    {
        Options options;
        try
        {
            options=Options.Parse(args);
            if(args.Any(x=>x.StartsWith("--internal-",StringComparison.Ordinal)||x=="--owned-journal-id")) throw new ArgumentException("INTERNAL_WORKER_FLAGS_RESERVED");
            if(resolve!=null)
            {
                var storage=resolve();
                if(options.Journal!=null)
                {
                    var physical=storage.Bind(options.Journal);
                    Evidence.Emit("JOURNAL_PATH_BOUND",new { requestedPath=options.Journal,path=physical,storage,workerStarted=false,policyCalls=0 });
                    args=BindJournalArguments(args,physical);
                    options=options with { Journal=physical };
                }
            }
        }
        catch(Exception e) { Evidence.Emit("SUPERVISOR_ARGUMENTS_REJECTED",new { error=e.Message,policyCalls=0,workerStarted=false }); return 2; }
        try { return start(args,options); }
        catch(Exception e)
        {
            // The failure may follow a successful native setter or worker startup.
            // Never rewrite uncertain history as zero mutations or restored state.
            return ReportUncertainFailure(e,options.Journal);
        }
    }
    internal static string[] BindJournalArguments(string[] args,string physicalPath)
    {
        var copy=(string[])args.Clone(); var index=Array.IndexOf(copy,"--journal");
        if(index<0 || index+1>=copy.Length) throw new ArgumentException("JOURNAL_ARGUMENT_REQUIRED");
        copy[index+1]=physicalPath; return copy;
    }
    internal static int ReportUncertainFailure(Exception error,string? journal)
    {
        Evidence.Emit("SUPERVISOR_FAILED_UNCERTAIN",new { error=error.Message,policyMutationStatus="unknown",restored=false,
            automaticRecoveryStarted=false,journal }); return 95;
    }
    private static Task<int> RunAsync(string[] args,Options options)=>RunBoundAsync(args,options,null);
    private static async Task<int> RunBoundAsync(string[] args,Options options,JournalRootLease? root)
    {
        var cancelled=0;
        ConsoleCancelEventHandler handler=(_,e)=> { e.Cancel=true; Interlocked.Exchange(ref cancelled,1); };
        Console.CancelKeyPress+=handler;
        RetainedJournal? retained=null;
        try
        {
            var context=new HandoffContext(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),options,root?.Binding,root,new WindowsJournalHandleTransfer());
            Evidence.Emit("SUPERVISOR_STARTED",new { mode=options.Mode,workerLimitMs=WorkerLimitMs,
                preparationWorkerLimitMs=options.Mode=="roundtrip"?PreparationLimitMs:(int?)null,
                absoluteWorkerLimitMs=options.Mode=="roundtrip"?RoundtripAbsoluteLimitMs:WorkerLimitMs,
                budgetMeaning="Acknowledged Prepared retention starts the bounded execution phase once within the fixed worker cap; not an OS route lease.",
                cancelGraceMs=CancelGraceMs,exitGraceMs=ExitGraceMs,recoveryLimitMs=RecoveryLimitMs,
                warning="Closing all trial processes prevents recovery. Interrupted runs remain uncertain even if subsequent original values are read back." });
            var result=await ChildBoundCore(args,false,options.Mode=="roundtrip"?RoundtripAbsoluteLimitMs:WorkerLimitMs,
                ()=>Volatile.Read(ref cancelled)!=0,options.Mode=="roundtrip"?PreparationLimitMs:null,WorkerLimitMs,context,null).ConfigureAwait(false);
            retained=result.Retained;
            Evidence.Emit("WORKER_PROCESS_RESULT",result);
            if(!result.Exited)
            {
                Evidence.Emit("STOPPED_UNCERTAIN_CHILD_EXIT",new { journal=options.Journal,restored=false,recoveryStarted=false,
                    reason="Original worker exit was not observed; no competing recovery is permitted." }); return 91;
            }
            if(options.Mode=="preflight") return result.ExitCode??92;
            var clean=CleanTerminal(result);
            if(clean) return 5;
            if(options.Mode=="restore")
            {
                Evidence.Emit("RESTORE_ATTEMPT_UNCERTAIN",new { process=result,policyMutationStatus="unknown",restored=false,
                    recoveryStarted=false,reason="Explicit restore needs its current-run terminal receipt and clean exit; no automatic retry." }); return 96;
            }
            if(result.CreatedJournal==null || retained==null || !retained.Receipt.Fresh || options.Journal==null)
            {
                Evidence.Emit("NO_OWNED_RECOVERY_PROOF",new { journal=options.Journal,policyMutationStatus="unknown",restored=false,recoveryStarted=false,
                    reason="No authenticated durable Prepared receipt with a validated retained exclusive journal handle." }); return 93;
            }
            root?.Validate();
            Evidence.Emit("BOUNDED_RECOVERY_STARTED",new { journal=options.Journal,originalWorkerExited=true,maximumAttempts=1,
                uncertainRpc=result.TimedOut || result.Killed,warning="Original interruption remains uncertain; a delayed RPC cannot be excluded by readback." });
            var recovered=await ChildBoundCore(args,true,RecoveryLimitMs,()=>false,null,WorkerLimitMs,context,retained).ConfigureAwait(false);
            Evidence.Emit("RECOVERY_PROCESS_RESULT",new { process=recovered,journal=options.Journal,journalRetained=true,
                fullRoundtripSuccess=false,originalRunUncertain=true,policyOriginalsReadBackWithTerminalReceipt=CleanTerminal(recovered) });
            return 94;
        }
        finally { retained?.Dispose(); Console.CancelKeyPress-=handler; }
    }
    internal static bool CleanTerminal(Result result)=>result.Exited && result.ExitCode==5 && result.TerminalValidated &&
        !result.TimedOut && !result.Killed && !result.OutputLimit && !result.CancellationSent && !result.ProtocolFailure;
    private static Task<Result> Child(string[] args,bool recover,int limitMs,Func<bool> cancelled)
        =>ChildCore(args,recover,limitMs,cancelled,null,WorkerLimitMs);
    private static Task<Result> ChildCore(string[] args,bool recover,int limitMs,Func<bool> cancelled,int? preparationLimitMs,int mutationLimitMs)
        =>ChildBoundCore(args,recover,limitMs,cancelled,preparationLimitMs,mutationLimitMs,
            new HandoffContext(Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),null,null,null,new WindowsJournalHandleTransfer()),null);
    internal static async Task<Result> ChildBoundCore(string[] args,bool recover,int limitMs,Func<bool> cancelled,int? preparationLimitMs,int mutationLimitMs,
        HandoffContext context,RetainedJournal? recovery)
    {
        if(recover!=(recovery!=null)) throw new InvalidOperationException("RECOVERY_RETAINED_HANDLE_REQUIRED");
        recovery?.ClaimRecovery();
        context.Root?.Validate();
        var executable=Environment.ProcessPath??throw new InvalidOperationException("EXECUTABLE_PATH_UNAVAILABLE");
        var start=new ProcessStartInfo(executable) { UseShellExecute=false,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true };
        if(string.Equals(Path.GetFileNameWithoutExtension(executable),"dotnet",StringComparison.OrdinalIgnoreCase)) start.ArgumentList.Add(CurrentAssembly());
        start.ArgumentList.Add(recover?"--internal-recover":"--internal-worker");
        foreach(var arg in args) start.ArgumentList.Add(arg);
        var nonce=Convert.ToHexString(RandomNumberGenerator.GetBytes(32)); start.Environment[NonceVariable]=nonce;
        using var parent=Process.GetCurrentProcess();
        using var child=Process.Start(start)??throw new InvalidOperationException("WORKER_START_FAILED");
        _=child.Handle;
        var childStarted=ProcessBirth(child);
        var timer=Stopwatch.StartNew(); var deadline=new WorkerDeadline(limitMs,preparationLimitMs,mutationLimitMs);
        var total=0; var outputLimit=0; var protocolFailure=0;
        var proof=new RunJournalProof(RunJournalProof.ArgumentValue(args,"--journal"),context.Storage,context.RunId,
            context.Options?.Pid,context.Options?.ExpectedStartTimeUtcTicks,context.Options?.Target,context.Options?.Mode=="restore");
        if(recovery!=null) proof.UseRecovery(recovery);
        var writes=new SemaphoreSlim(1,1);
        var shutdown=new CancellationTokenSource();
        async Task Send(string text)
        {
            using var bound=CancellationTokenSource.CreateLinkedTokenSource(shutdown.Token);bound.CancelAfter(2_000);
            await writes.WaitAsync(bound.Token).ConfigureAwait(false);
            try { await child.StandardInput.WriteLineAsync(text.AsMemory(),bound.Token).ConfigureAwait(false); await child.StandardInput.FlushAsync(bound.Token).ConfigureAwait(false); }
            finally { writes.Release(); }
        }
        async Task Observe(string line)
        {
            shutdown.Token.ThrowIfCancellationRequested();
            JsonDocument document;
            try { document=JsonDocument.Parse(line); } catch(JsonException) { return; }
            using(document)
            {
                if(!document.RootElement.TryGetProperty("status",out var status)) return;
                var kind=status.GetString();
                if(kind is not ("JOURNAL_PREPARED" or "EXPLICIT_RESTORE_OPENED" or "JOURNAL_TERMINAL")) return;
                var evidence=document.RootElement.GetProperty("evidence");
                var sid=context.Storage?.UserSid??throw new InvalidOperationException("UNPROVED_STORAGE_RECEIPT");
                if(kind=="JOURNAL_TERMINAL")
                {
                    proof.AcceptTerminal(evidence.Deserialize<TerminalJournalReceipt>()??throw new InvalidDataException(),child.Id,childStarted,sid);
                    return;
                }
                if(recover || (kind=="EXPLICIT_RESTORE_OPENED")!=(context.Options?.Mode=="restore")) throw new InvalidOperationException("UNEXPECTED_PREPARED_RECEIPT");
                var receipt=evidence.Deserialize<PreparedJournalReceipt>()??throw new InvalidDataException();
                var held=proof.AcceptPrepared(receipt,child.Id,childStarted,sid,value=>
                {
                    context.Root?.Validate();
                    var handle=context.Transfer.Retain(child,childStarted,sid,value.HandleValue);
                    try { context.ValidateHandle(handle,value.Path,value.FileIdentity); return handle; }
                    catch { handle.Dispose(); throw; }
                });
                await Send(JsonSerializer.Serialize(new WorkerCommand("PREPARED_ACK",context.RunId,nonce,held.Receipt.Prepared.FrameHash))).ConfigureAwait(false);
                deadline.JournalCreated(timer.ElapsedMilliseconds);
            }
        }
        async Task Pump(StreamReader reader,bool error)
        {
            var buffer=new char[2048]; var pending=new StringBuilder();
            try
            {
                while(true)
                {
                    var read=await reader.ReadAsync(buffer.AsMemory(),shutdown.Token).ConfigureAwait(false); if(read==0) break;
                    if(Interlocked.Add(ref total,read)>MaximumOutputChars) { Interlocked.Exchange(ref outputLimit,1); return; }
                    foreach(var c in buffer.AsSpan(0,read).ToArray())
                    {
                        if(c=='\n')
                        {
                            var line=pending.ToString().TrimEnd('\r'); pending.Clear();
                            if(!error) await Observe(line).ConfigureAwait(false);
                            shutdown.Token.ThrowIfCancellationRequested();
                            if(error) Evidence.Emit("WORKER_STDERR",new { text=line }); else Console.WriteLine(line);
                        }
                        else { pending.Append(c); if(pending.Length>MaximumLineChars) { Interlocked.Exchange(ref outputLimit,1); return; } }
                    }
                }
                if(pending.Length!=0) { Interlocked.Exchange(ref protocolFailure,1); }
            }
            catch(Exception e)
            {
                Interlocked.Exchange(ref protocolFailure,1);
                if(!shutdown.IsCancellationRequested) Evidence.Emit("WORKER_PROTOCOL_REJECTED",new {error=e.Message});
            }
        }
        var output=Pump(child.StandardOutput,false); var error=Pump(child.StandardError,true);
        var exited=child.WaitForExitAsync(); bool timedOut=false,killed=false,cancelSent=false;
        async Task Drain(bool observed)
        {
            var pumps=Task.WhenAll(output,error);
            var settled=observed && await Task.WhenAny(pumps,Task.Delay(500)).ConfigureAwait(false)==pumps;
            if(!settled) Interlocked.Exchange(ref protocolFailure,1);
            proof.CloseObservations(!settled || Volatile.Read(ref protocolFailure)!=0);
            shutdown.Cancel();
            if(!settled)
            {
                try {child.StandardOutput.Close();} catch { }
                try {child.StandardError.Close();} catch { }
            }
            if(observed && !recover) proof.OwnedRetention?.ConfirmOriginalExit(child,childStarted);
        }
        try
        {
            RecoveryJournalImport? import=null;
            if(recovery!=null)
            {
                context.ValidateHandle(recovery.Handle,recovery.Receipt.Path,recovery.Receipt.FileIdentity);
                import=new(context.Transfer.Send(child,childStarted,context.Storage!.UserSid,recovery.Handle),recovery.Receipt);
            }
            var h=new WorkerHandshake(nonce,context.RunId,parent.Id,ProcessBirth(parent),executable,CurrentAssembly(),context.Storage,import);
            await Send(JsonSerializer.Serialize(h)).ConfigureAwait(false);
            while(!exited.IsCompleted && Volatile.Read(ref outputLimit)==0 && Volatile.Read(ref protocolFailure)==0 && Evidence.OutputAvailable && !cancelled())
            {
                if(deadline.Expired(timer.ElapsedMilliseconds)) { timedOut=true; break; }
                await Task.WhenAny(exited,Task.Delay(25)).ConfigureAwait(false);
            }
            if(!exited.IsCompleted)
            {
                cancelSent=true;
                try { await Send("CANCEL").ConfigureAwait(false); } catch { Interlocked.Exchange(ref protocolFailure,1); }
                await Task.WhenAny(exited,Task.Delay(CancelGraceMs)).ConfigureAwait(false);
                if(!exited.IsCompleted)
                {
                    try { child.Kill(entireProcessTree:false); killed=true; }
                    catch(InvalidOperationException) { }
                    catch(Exception e) { Evidence.Emit("OWN_WORKER_KILL_FAILED",new {error=e.Message}); }
                    await Task.WhenAny(exited,Task.Delay(ExitGraceMs)).ConfigureAwait(false);
                }
            }
            var observed=exited.IsCompletedSuccessfully && child.HasExited;
            await Drain(observed).ConfigureAwait(false);
            return new(observed?child.ExitCode:null,observed,timedOut,killed,Volatile.Read(ref outputLimit)!=0,cancelSent,
                proof.Get(),proof.TerminalValidated,proof.OwnedRetention,Volatile.Read(ref protocolFailure)!=0);
        }
        catch(Exception e)
        {
            Evidence.Emit("WORKER_SUPERVISION_ERROR",new {error=e.Message});
            try { if(!child.HasExited) { child.Kill(entireProcessTree:false); killed=true; } } catch { }
            await Task.WhenAny(exited,Task.Delay(ExitGraceMs)).ConfigureAwait(false);
            var observed=exited.IsCompletedSuccessfully && child.HasExited;
            await Drain(observed).ConfigureAwait(false);
            return new(observed?child.ExitCode:null,observed,true,killed,Volatile.Read(ref outputLimit)!=0,cancelSent,
                proof.Get(),false,proof.OwnedRetention,true);
        }
    }
}
