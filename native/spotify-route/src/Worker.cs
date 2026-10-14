using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Folia.RouteResearch;
using Folia.RouteResearch.Native;
using Folia.RouteResearch.Windows;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal sealed record Options(string Mode,int? Pid,string Target,string? Journal,int? ReviewedBuild,string? AbiReview,
    bool DefaultOutput,bool ExclusiveOff,bool Paused,bool ShortUiPlay=false,string? OriginalEndpoint=null,long? ExpectedStartTimeUtcTicks=null)
{
    internal const string DefaultTarget="{0.0.0.00000000}.{95216355-ae7a-4a0c-bca0-2aad7b61ac0b}";
    internal static Options Parse(string[] args)
    {
        string mode="preflight",target=DefaultTarget; string? journal=null,review=null,originalEndpoint=null; int? pid=null,build=null;
        long? expectedStartTimeUtcTicks=null;
        bool output=false,exclusive=false,paused=false,shortUiPlay=false,explicitMode=false,explicitTarget=false;
        var seen=new HashSet<string>();
        for(int i=0;i<args.Length;i++)
        {
            var key=args[i]; if(key is "--internal-worker" or "--internal-recover") continue;
            if(!seen.Add(key)) throw new ArgumentException("DUPLICATE_OPTION:"+key);
            string Value() { if(++i>=args.Length || args[i].StartsWith("--",StringComparison.Ordinal)) throw new ArgumentException("MISSING_VALUE:"+key); return args[i]; }
            switch(key)
            {
                case "--preflight": case "--roundtrip": case "--restore": if(explicitMode) throw new ArgumentException("ONE_MODE_REQUIRED"); mode=key[2..]; explicitMode=true; break;
                case "--pid": pid=int.Parse(Value(),System.Globalization.CultureInfo.InvariantCulture); if(pid<=0) throw new ArgumentException("PID_REQUIRED"); break;
                case "--target": target=Value(); explicitTarget=true; break;
                case "--original-endpoint": originalEndpoint=Value(); break;
                case "--expected-start-time-utc-ticks":
                    expectedStartTimeUtcTicks=long.Parse(Value(),System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture);
                    if(expectedStartTimeUtcTicks<=0) throw new ArgumentException("POSITIVE_EXACT_START_TICKS_REQUIRED");
                    break;
                case "--journal": journal=Path.GetFullPath(Value()); break;
                case "--reviewed-build": build=int.Parse(Value(),System.Globalization.CultureInfo.InvariantCulture); break;
                case "--abi-review": review=Value(); break;
                case "--attest-default-output": output=true; break;
                case "--attest-exclusive-off": exclusive=true; break;
                case "--attest-paused": paused=true; break;
                case "--attest-short-ui-play": shortUiPlay=true; break;
                default: throw new ArgumentException("UNKNOWN_OPTION:"+key);
            }
        }
        if(mode!="preflight" && (pid is null || journal is null || build is null || string.IsNullOrWhiteSpace(review)))
            throw new ArgumentException("MUTATION_REQUIRES_PID_JOURNAL_REVIEWED_BUILD_AND_ABI_REVIEW");
        if(mode=="roundtrip" && (!explicitTarget || !output || !exclusive || !paused || !shortUiPlay || string.IsNullOrWhiteSpace(originalEndpoint) || expectedStartTimeUtcTicks is null))
            throw new ArgumentException("ROUNDTRIP_REQUIRES_TARGET_ORIGINAL_EXACT_START_TICKS_AND_UI_ATTESTATIONS");
        return new(mode,pid,target,journal,build,review,output,exclusive,paused,shortUiPlay,originalEndpoint,expectedStartTimeUtcTicks);
    }
}

internal static class Evidence
{
    private static int outputLost;
    internal static bool OutputAvailable=>Volatile.Read(ref outputLost)==0;
    internal static void Emit(string status,object? evidence=null)
    {
        try {Console.WriteLine(JsonSerializer.Serialize(new {status,atUtc=DateTimeOffset.UtcNow,evidence}));Console.Out.Flush();}
        catch(Exception e) when(e is IOException or ObjectDisposedException)
        {
            Interlocked.Exchange(ref outputLost,1);
            // Diagnostics must not interrupt compensation after a native setter.
            // Loss of the channel withdraws further apply authority and terminal
            // reporting, while a valid held journal can still record cleanup.
            WorkerChannel.MarkOutputLost();
        }
    }
}
internal sealed record WindowsVersion(uint Major,uint Minor,uint Build,byte ProductType);
internal static class ActualWindows
{
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] private struct Version
    { public uint Size,Major,Minor,Build,Platform; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string ServicePack; public ushort SpMajor,SpMinor,Suite; public byte ProductType,Reserved; }
    [DllImport("ntdll.dll")] private static extern int RtlGetVersion(ref Version value);
    internal static WindowsVersion Read()
    {
        var v=new Version{Size=(uint)Marshal.SizeOf<Version>(),ServicePack=""}; var hr=RtlGetVersion(ref v);
        if(hr<0) Marshal.ThrowExceptionForHR(hr); return new(v.Major,v.Minor,v.Build,v.ProductType);
    }
}

// Snapshot facts never implement a complete-session proof. The strict core will
// conservatively roll back after this observer returns CompleteForProcess=false.
internal static class SnapshotFacts
{
    internal static SessionObservation ForProcess(SpotifyProcess process,NativeSession[] snapshot) =>
        new(false,process,DateTimeOffset.UtcNow,snapshot.Where(x=>x.HasSingleProcessIdentity && x.IsSystemSounds==false && x.ReportedProcessId==process.Pid)
            .Select(x=>new RenderSession(process,x.InstanceId,x.EndpointId,x.State==1)).ToArray());
    internal static bool HasActiveOn(SessionObservation observation,string endpoint)
    {
        var active=observation.Sessions.Where(x=>x.Active).ToArray();
        return active.Length>0 && active.All(x=>string.Equals(x.EndpointId,endpoint,StringComparison.OrdinalIgnoreCase));
    }
}
internal sealed class PollObserver(Func<NativeSession[]> scan,string target,Func<bool> cancelled,
    Func<long>? elapsedMs=null,Action<int>? delay=null):ISessionObserver
{
    internal bool TargetObserved { get; private set; }
    public SessionObservation Observe(IBoundSpotifyPolicy bound,TimeSpan maximumWait)
    {
        var timer=Stopwatch.StartNew();
        long Elapsed()=>elapsedMs?.Invoke()??timer.ElapsedMilliseconds;
        Evidence.Emit("TARGET_OBSERVATION_BOUNDED",new { pid=bound.Identity.Pid,target,maximumObserveMilliseconds=maximumWait.TotalMilliseconds,
            instruction="Playback was already observed during readonly prepare. Keep the original actual Play+30-second and FIRST_READY+90-second pause deadlines; do not wait for another action or restart playback.",
            completeForProcess=false,productionReady=false });
        SessionObservation? latest=null;
        do
        {
            if(cancelled()) throw new RouteBlockedException("SUPERVISOR_CANCELLED");
            if(Elapsed()>=maximumWait.TotalMilliseconds) break;
            bound.CheckLiveIdentity(); var snapshot=scan(); bound.CheckLiveIdentity();
            if(cancelled() || Elapsed()>=maximumWait.TotalMilliseconds)
            { Evidence.Emit("TARGET_LATE_SNAPSHOT_REJECTED",new { elapsedMilliseconds=Elapsed(),completeForProcess=false }); break; }
            SessionIdentity.RequireUnambiguousForApply(snapshot);
            latest=SnapshotFacts.ForProcess(bound.Identity,snapshot);
            if(SnapshotFacts.HasActiveOn(latest,target))
            {
                TargetObserved=true; Evidence.Emit("TARGET_SESSION_OBSERVED",new { observation=latest,
                    scope="All visible active sessions for the verified PID were on target in this partial snapshot; unobserved sessions may exist",completeForProcess=false,productionReady=false });
                return latest; // Complete=false makes the unchanged strict core roll back.
            }
            if(Elapsed()>=maximumWait.TotalMilliseconds) break; (delay??Thread.Sleep)(50);
        } while(Elapsed()<maximumWait.TotalMilliseconds);
        Evidence.Emit("TARGET_SESSION_NOT_OBSERVED",new { observation=latest,completeForProcess=false });
        return latest??throw new RouteBlockedException("SESSION_NOT_OBSERVED");
    }
}

public static class Worker
{
    private static int cancel;
    public static void RequestCancellation()=>Interlocked.Exchange(ref cancel,1);
    private static bool Cancelled => Volatile.Read(ref cancel)!=0;
    public static int Run(string[] args)
    {
        try
        {
            var options=Options.Parse(args);
            if(!OperatingSystem.IsWindows() || RuntimeInformation.ProcessArchitecture!=Architecture.X64)
            { Evidence.Emit("PREFLIGHT_BLOCKED",new { blocker="WINDOWS_X64_REQUIRED",setters=0,streamInitializations=0 }); return 2; }
            return options.Mode=="restore"?Restore(options):InspectOrRoundtrip(options);
        }
        catch(Exception e) { Evidence.Emit("WORKER_FAILED",new { type=e.GetType().Name,error=e.Message,hresult=e.HResult,policyMutationStatus="unknown",restored=false,journalRetained=true }); return 3; }
    }
    public static int Recover(string[] args)
    {
        try
        {
            var import=WorkerChannel.Recovery??throw new RouteBlockedException("CURRENT_RUN_JOURNAL_OWNERSHIP_REQUIRED");
            var o=Options.Parse(args);
            if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_REQUIRED");
            return Restore(o with { Mode="restore" },import);
        }
        catch(Exception e)
        { Evidence.Emit("RECOVERY_FAILED",new { error=e.Message,policyMutationStatus="unknown",restored=false,journalRetained=true }); return 4; }
    }
    private static int InspectOrRoundtrip(Options o)
    {
        var root=WorkerChannel.Root??throw new JournalUnavailableException("AUTHENTICATED_ROOT_LEASE_REQUIRED");
        root.Validate();
        var path=root.Binding.Bind(o.Journal??Path.Combine(root.Binding.LogicalRoot,Guid.NewGuid().ToString("D")+".jsonl"));
        using var guard=new JournalGuard(root,path,true);
        Evidence.Emit("JOURNAL_PATH_CAPABILITY",new {requestedPath=o.Journal,path,storage=root.Binding,ancestryPinned=true,journalCreated=false,
            writeCapability="not probed; exclusive CreateNew, durable Prepared and retained-handle ACK still required",setters=0,policyCalls=0,streamInitializations=0});
        return InspectOrRoundtripProved(o with {Journal=path},root,guard);
    }
    private static int InspectOrRoundtripProved(Options o,JournalRootLease root,JournalGuard journalGuard)
    {
        var storage=root.Binding;
        var version=ActualWindows.Read();
        Evidence.Emit("PLATFORM",new { version,architecture=RuntimeInformation.ProcessArchitecture.ToString(),abi=new { Win11AppRouteAbi.InterfaceId,Win11AppRouteAbi.SetSlot,Win11AppRouteAbi.GetSlot,Win11AppRouteAbi.AuditedSourceSha256 },
            abiWriteReview=new { o.ReviewedBuild,o.AbiReview,kind="operator-supplied exact-build review; no cloud Windows execution claim" },
            uiAttestations=new { o.DefaultOutput,o.ExclusiveOff,o.Paused,o.ShortUiPlay,kind="operator attestation, not programmatic proof" } });
        using var audio=new AudioReadOnly();
        var endpoints=audio.Endpoints(2,15); var defaults=Enumerable.Range(0,3).Select(role=>new { role,endpoint=audio.Default(role) }).ToArray();
        Evidence.Emit("READONLY_ENDPOINTS",new { endpoints,defaults });
        var allSessions=ReadOnlyDiagnostics.Scan(()=>
        {
            var candidates=Process.GetProcessesByName("Spotify");
            try { return candidates.Select(x=>x.Id).Order().ToArray(); }
            finally { foreach(var candidate in candidates) candidate.Dispose(); }
        },()=>audio.Sessions(true));
        if(o.Pid is null)
        {
            Evidence.Emit("PREFLIGHT_BLOCKED",new {blocker="EXACT_SPOTIFY_AUDIO_PID_REQUIRED",setters=0,streamInitializations=0});
            return 2;
        }

        using var identity=new SpotifyIdentity(o.Pid.Value); Evidence.Emit("SPOTIFY_IDENTITY",new { identity.Identity,identity.Publisher,signatureRevocation="offline-cache-only; no online revocation claim" });
        if(o.ExpectedStartTimeUtcTicks is long expectedTicks)
        {
            Evidence.Emit("EXPECTED_SPOTIFY_START_TIME",new { pid=identity.Identity.Pid,
                expectedStartTimeUtcTicksText=expectedTicks.ToString(System.Globalization.CultureInfo.InvariantCulture),
                actualStartTimeUtcTicksText=identity.Identity.StartTimeUtcTicks.ToString(System.Globalization.CultureInfo.InvariantCulture),
                matches=identity.Identity.StartTimeUtcTicks==expectedTicks,readyEmitted=false,setters=0 });
            RequireExpectedProcessStart(identity.Identity,expectedTicks);
        }
        var endpoint=audio.Select(o.Target); Evidence.Emit("VERIFIED_TARGET",endpoint);
        // Do not activate the undocumented ABI until an exact build review is
        // supplied. Default preflight still reports actual OS, PnP and sessions.
        if(o.ReviewedBuild!=(int)version.Build || string.IsNullOrWhiteSpace(o.AbiReview))
        {
            Evidence.Emit("PREFLIGHT_BLOCKED",new { blocker="EXACT_BUILD_ABI_REVIEW_REQUIRED",actualBuild=version.Build,
                routes="Not read: undocumented ABI activation blocked",setters=0,streamInitializations=0 }); return 2;
        }
        FileRouteJournal? guardedJournal=null;
        FrozenOriginals? frozen=null;
        Stopwatch? prepareTimer=null;
        Func<string?[]>? readPolicies=null;
        var firstApply=true;
        var resolver=new Win11SpotifyPolicyResolver(identity.Check,(operation,role,hr)=>Evidence.Emit("POLICY_CALL",new { operation,role=(int)role,hresult="0x"+unchecked((uint)hr).ToString("X8") }),
            beforeSet:()=>
            {
                var owned=guardedJournal??throw new JournalUnavailableException("JOURNAL_NOT_OPEN");
                owned.ValidateStorage();
                var record=owned.ReadLatest();
                // Observation and mapping guards are apply-only. They must never
                // prevent owned compensation back to exact raw originals.
                if(record?.Stage!=RouteStage.Applying) return;
                RequireParentForApply(record,WorkerChannel.RequireParentAlive);
                if(frozen==null || prepareTimer==null) throw new RouteBlockedException("PREPARE_REQUIRED");
                if(!record.Roles.Select(x=>x.Original).SequenceEqual(frozen.Values))
                    throw new RouteBlockedException("FROZEN_ORIGINAL_POLICY_CHANGED");
                BoundedPrepare.RequirePreparedPolicyValues(record,frozen,readPolicies?.Invoke()??throw new RouteBlockedException("POLICY_READER_NOT_READY"));
                if(Cancelled || prepareTimer.ElapsedMilliseconds>=BoundedPrepare.MaximumPrepareMs)
                    throw new RouteBlockedException("PREPARE_DEADLINE_OR_CANCELLED");
                CheckFrozenMapping(audio,frozen);
                var rows=BoundedPrepare.BracketedSnapshot(identity.Identity,()=>identity.Check(identity.Identity.Pid),
                    ()=>audio.Sessions(true),()=>Cancelled,()=>prepareTimer.ElapsedMilliseconds,BoundedPrepare.MaximumPrepareMs);
                var sampleAt=prepareTimer.ElapsedMilliseconds;
                BoundedPrepare.RequireNoOtherSpotify(rows,identity.Identity.Pid,SpotifyCandidatePids());
                if(firstApply)
                {
                    if(!BoundedPrepare.ActiveOriginalOnly(identity.Identity,rows,frozen,endpoint.Id))
                        throw new RouteBlockedException("ACTIVE_ORIGINAL_REQUIRED_IMMEDIATELY_BEFORE_FIRST_SET");
                }
                else
                {
                    // Role0 may already have moved the session. Original/target
                    // transitions are permitted, unknown endpoints are not.
                    BoundedPrepare.RequireTransitionEndpoints(identity.Identity,rows,frozen,endpoint.Id);
                }
                CheckFrozenMapping(audio,frozen);
                BoundedPrepare.RequirePreparedPolicyValues(record,frozen,readPolicies());
                if(Cancelled || prepareTimer.ElapsedMilliseconds>=BoundedPrepare.MaximumPrepareMs)
                    throw new RouteBlockedException("PREPARE_DEADLINE_OR_CANCELLED");
                if(prepareTimer.ElapsedMilliseconds-sampleAt>BoundedPrepare.MaximumScanMs)
                    throw new RouteBlockedException("PREPARE_SAMPLE_BECAME_STALE");
                firstApply=false;
            });
        string?[] ReadPolicies()
        {
            using var bound=resolver.OpenVerified(identity.Identity);
            return Enum.GetValues<RenderRole>().Select(bound.Get).ToArray();
        }
        readPolicies=ReadPolicies;
        var originals=ReadPolicies();
        Evidence.Emit("READONLY_ROUTES",new { roles=originals.Select((value,role)=>new { role,value }).ToArray(),setters=0,streamInitializations=0 });
        frozen=FrozenOriginals.Read(originals,audio.Default,audio.EndpointForPolicy);
        identity.Check(identity.Identity.Pid);
        var baseline=audio.Sessions(true);
        identity.Check(identity.Identity.Pid);
        var blockers=new List<string>();
        try { SessionIdentity.RequireUnambiguousForApply(baseline); BoundedPrepare.RequireNoOtherSpotify(baseline,identity.Identity.Pid,SpotifyCandidatePids()); }
        catch(RouteBlockedException e) { blockers.Add(e.Message); }
        if(SnapshotFacts.ForProcess(identity.Identity,baseline).Sessions.Any(x=>x.Active)) blockers.Add("SPOTIFY_MUST_BE_PAUSED_BEFORE_PREPARE");
        if(originals.Take(2).All(x=>x==endpoint.PolicyValue)) blockers.Add("BOTH_ROLES_ALREADY_TARGET_NO_OWNED_ROUNDTRIP");
        if(!o.DefaultOutput || !o.ExclusiveOff || !o.Paused || (o.Mode=="roundtrip" && !o.ShortUiPlay)) blockers.Add("UI_ATTESTATIONS_REQUIRED");
        if(o.Mode=="roundtrip" && frozen.Endpoints.Any(x=>!string.Equals(x,o.OriginalEndpoint,StringComparison.OrdinalIgnoreCase)))
            blockers.Add("EXACT_REVIEWED_ORIGINAL_ENDPOINT_MISMATCH");
        foreach(var originalEndpoint in frozen.Endpoints.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var original=audio.Endpoint(originalEndpoint);
            if(original.State!=1 || original.Flow!=0 || string.Equals(originalEndpoint,endpoint.Id,StringComparison.OrdinalIgnoreCase) ||
                original.BaseIdentity.State!="unsupported") blockers.Add("ORIGINAL_ACTIVE_RENDER_OUTSIDE_VERIFIED_BASE_FAMILY_UNPROVED");
        }
        Evidence.Emit("PREFLIGHT_RESULT",new { mode=o.Mode,blockers=blockers.Distinct().ToArray(),setters=0,streamInitializations=0,baseline,
            baselineScope="Bracketed verified selected PID; inactive old target rows remain evidence and never count as entry proof",frozenOriginals=frozen });
        if(o.Mode=="preflight") return blockers.Count==0?0:2;
        if(blockers.Count!=0) return 2;
        if(Cancelled) throw new RouteBlockedException("SUPERVISOR_CANCELLED");
        // Acquire the exact same held-ancestry guard before asking for external
        // playback. Keep it through prepare/apply/restore; no journal leaf exists
        // yet and the exclusive CreateNew/leaf validation remains below.
        journalGuard.ValidateDirectories();
        Evidence.Emit("JOURNAL_ANCESTRY_PINNED_BEFORE_READY",new { path=o.Journal,storage,journalCreated=false,setters=0,streamInitializations=0 });
        frozen.Check(ReadPolicies(),audio.Default,audio.EndpointForPolicy);
        prepareTimer=Stopwatch.StartNew();
        Evidence.Emit("FIRST_READY_READONLY_PREPARE",BoundedPrepare.ReadyEvidence(DateTimeOffset.UtcNow,identity.Identity.Pid,frozen));
        var prepared=BoundedPrepare.Wait(identity.Identity,frozen,endpoint.Id,()=>audio.Sessions(true),()=>identity.Check(identity.Identity.Pid),
            ()=>frozen.Check(ReadPolicies(),audio.Default,audio.EndpointForPolicy),SpotifyCandidatePids,()=>Cancelled,()=>prepareTimer.ElapsedMilliseconds,Thread.Sleep);
        Evidence.Emit("ACTIVE_ORIGINAL_OBSERVED",new { prepared,completeForProcess=false,productionReady=false,
            meaning="Fresh partial active-original sample; no same-session-object or complete routing claim" });
        frozen.Check(ReadPolicies(),audio.Default,audio.EndpointForPolicy);
        if(Cancelled || prepareTimer.ElapsedMilliseconds>=BoundedPrepare.MaximumPrepareMs) throw new RouteBlockedException("PREPARE_DEADLINE_OR_CANCELLED");
        using var journal=new FileRouteJournal(o.Journal!,createNew:true,validateHandle:journalGuard.Validate,
            afterDurableAppend:commit=>
            {
                if(commit.Record.Stage==RouteStage.Prepared)
                    WorkerChannel.PublishPrepared(guardedJournal??throw new JournalUnavailableException("JOURNAL_NOT_OPEN"),journalGuard,root,commit,true);
            });
        guardedJournal=journal;
        Evidence.Emit("JOURNAL_CREATED",new { path=o.Journal,storage,fileIdentity=journalGuard.FileIdentity,recoveryAuthority=false });
        var observer=new PollObserver(()=>audio.Sessions(true),endpoint.Id,()=>Cancelled);
        var transaction=new OwnedRouteTransaction(resolver,audio,observer,journal,cancelRequested:()=>Cancelled);
        RouteRecord? result=null; bool journalFault=false;
        try
        {
            Evidence.Emit("APPLY_BEGIN",new { journal=o.Journal,roles=new[]{0,1},communications="read-only" });
            result=transaction.Begin(identity.Identity,endpoint);
            Evidence.Emit("ENTRY_RESULT",new { record=result,targetSessionObserved=observer.TargetObserved,completeForProcess=false,productionReady=false });
        }
        catch(JournalUnavailableException) { journalFault=true; throw; }
        finally
        {
            if(!journalFault && journal.ReadLatest()!=null)
            {
                Evidence.Emit("RESTORE_BEGIN",new { journal=o.Journal });
                result=transaction.Restore(); Evidence.Emit("RESTORE_RESULT",new { record=result,ownedRoleCompensationRecorded=result.Stage is RouteStage.Restored or RouteStage.RolledBack,allOriginalRolesReadBack="not yet checked",sessionReturnProved=false });
            }
        }
        if(result?.Stage is not (RouteStage.Restored or RouteStage.RolledBack)) return 4;
        var originalReadback=ReadAllOriginals(resolver,identity,result);
        var returnObserved=false; string? returnIssue=null;
        try { returnObserved=ObserveReturn(audio,identity,resolver,result,observer.TargetObserved,frozen); }
        catch(Exception e)
        {
            returnIssue=e.GetType().Name+":"+e.Message;
            Evidence.Emit("RETURN_OBSERVATION_UNAVAILABLE",new { error=returnIssue,completeForProcess=false,
                returnSessionObserved=false,allOriginalRolesPreviouslyReadBack=true,policyObservationDoesNotProveSessionReturn=true });
        }
        originalReadback=ReadAllOriginals(resolver,identity,result);
        WorkerChannel.EmitTerminal(journal,journalGuard,originalReadback);
        Evidence.Emit("BOUNDED_SNAPSHOT_TRIAL_RESULT",new { allOriginalRolesReadBack=true,originalReadback,targetSessionObserved=observer.TargetObserved,returnSessionObserved=returnObserved,returnIssue,
            completeForProcess=false,fullRoundtripProved=false,productionReady=false,sameSessionObjectMigrationProved=false,
            initialSessionInstanceIds=SnapshotFacts.ForProcess(identity.Identity,baseline).Sessions.Select(x=>x.SessionInstanceId).ToArray(),preparedOriginalSessionInstanceIds=prepared.Observation.Sessions.Select(x=>x.SessionInstanceId).ToArray(),journal=o.Journal,journalRetained=true,
            playbackState="Tool never changed playback. External tester must verify paused in normal Spotify UI." });
        return 5; // Restored policy and partial observations never become full-success 0.
    }
    private static bool ObserveReturn(AudioReadOnly audio,SpotifyIdentity identity,IVerifiedSpotifyResolver resolver,RouteRecord record,bool targetObserved,FrozenOriginals frozen)
    {
        var expected=frozen.Endpoints.ToHashSet(StringComparer.OrdinalIgnoreCase);
        Evidence.Emit("RETURN_OBSERVATION_READONLY",new { maximumObserveMilliseconds=5000,
            instruction="Keep the original actual Play+30-second and FIRST_READY+90-second pause deadlines. Do not continue or resume playback for return proof. Missing active proof after pause is reported honestly." });
        using var bound=resolver.OpenVerified(identity.Identity); var timer=Stopwatch.StartNew();
        do
        {
            bound.CheckLiveIdentity(); var snapshot=audio.Sessions(true); bound.CheckLiveIdentity();
            if(Cancelled || timer.Elapsed>=TimeSpan.FromSeconds(5))
            { Evidence.Emit("RETURN_LATE_SNAPSHOT_REJECTED",new {elapsedMilliseconds=timer.ElapsedMilliseconds,completeForProcess=false}); break; }
            CheckFrozenMapping(audio,frozen);
            SessionIdentity.RequireUnambiguousForApply(snapshot);
            var sessions=snapshot.Where(x=>x.HasSingleProcessIdentity && x.IsSystemSounds==false && x.ReportedProcessId==identity.Identity.Pid).ToArray();
            foreach(var role in record.Roles) if(bound.Get(role.Role)!=role.Original) throw new RouteBlockedException("POST_RESTORE_POLICY_CHANGED");
            if(Cancelled || timer.Elapsed>=TimeSpan.FromSeconds(5)) break;
            var active=sessions.Where(x=>x.State==1).ToArray();
            if(targetObserved && active.Length>0 && active.All(x=>expected.Contains(x.EndpointId)) &&
                active.Any(x=>!string.Equals(x.EndpointId,record.Target.Id,StringComparison.OrdinalIgnoreCase)))
            { Evidence.Emit("RETURN_SESSION_OBSERVED",new { expectedEndpoints=expected,sessions,completeForProcess=false,productionReady=false }); return true; }
            if(Cancelled || timer.Elapsed>=TimeSpan.FromSeconds(5)) break;
            Thread.Sleep(50);
        } while(timer.Elapsed<TimeSpan.FromSeconds(5));
        Evidence.Emit("RETURN_SESSION_NOT_OBSERVED",new { expectedEndpoints=expected,completeForProcess=false,
            reason="No selected-PID active return was seen within the bound; snapshots can omit sessions. Do not resume after the pause deadline." }); return false;
    }
    private static int[] SpotifyCandidatePids()
    {
        var candidates=Process.GetProcessesByName("Spotify");
        try { return candidates.Select(x=>x.Id).Distinct().ToArray(); }
        finally { foreach(var candidate in candidates) candidate.Dispose(); }
    }
    private static void CheckFrozenMapping(AudioReadOnly audio,FrozenOriginals frozen)
    {
        for(var role=0;role<2;role++)
        {
            var present=frozen.Values[role] is null?audio.Default(role):audio.EndpointForPolicy(frozen.Values[role]!);
            if(!string.Equals(present,frozen.Endpoints[role],StringComparison.OrdinalIgnoreCase))
                throw new RouteBlockedException("FROZEN_ORIGINAL_ENDPOINT_CHANGED");
        }
    }
    internal static void RequireParentForApply(RouteRecord? record,Action checkParent)
    {
        if(record?.Stage!=RouteStage.Applying) return;
        try {checkParent();}
        catch(Exception e) {throw new RouteBlockedException("PARENT_APPLY_AUTHORITY_LOST:"+e.GetType().Name);}
    }
    internal static void RequireAutomaticRecoveryIdentity(SpotifyProcess live,SpotifyProcess journalProcess)
    {
        if(live!=journalProcess) throw new RouteBlockedException("ReidentityRequired:AUTOMATIC_RECOVERY_EXACT_PROCESS_IDENTITY_CHANGED");
    }
    internal static void RequireExpectedProcessStart(SpotifyProcess live,long expectedTicks)
    {
        if(live.StartTimeUtcTicks!=expectedTicks) throw new RouteBlockedException("EXPECTED_SPOTIFY_PROCESS_START_CHANGED_KEEP_PAUSED_NO_APPLY");
    }
    private static RoleReadback[] ReadAllOriginals(IVerifiedSpotifyResolver resolver,SpotifyIdentity identity,RouteRecord record)
    {
        using var bound=resolver.OpenVerified(identity.Identity);
        var values=record.Roles.Select(role=>new RoleReadback(role.Role,role.Original,bound.Get(role.Role))).ToArray();
        var matches=values.All(x=>x.Expected==x.Actual);
        Evidence.Emit("ALL_ORIGINAL_ROLES_READBACK",new {values,allOriginalRolesReadBack=matches,observedAtUtc=DateTimeOffset.UtcNow});
        if(!matches) throw new RouteBlockedException("POST_RESTORE_POLICY_CHANGED");
        return values;
    }
    private static int Restore(Options o,RecoveryJournalImport? import=null)
    {
        if(o.Journal==null || o.Pid==null || o.ReviewedBuild==null || string.IsNullOrWhiteSpace(o.AbiReview)) throw new ArgumentException("RESTORE_ARGUMENTS_REQUIRED");
        var root=WorkerChannel.Root??throw new JournalUnavailableException("AUTHENTICATED_ROOT_LEASE_REQUIRED");
        root.Validate(); WorkerChannel.RequireParentAlive();
        o=o with { Journal=root.Binding.Bind(o.Journal) };
        if(import!=null)
        {
            if(import.Prepared.RunId!=WorkerChannel.RunId || !import.Prepared.Fresh || !JournalPath.SamePath(import.Prepared.Path,o.Journal))
                throw new JournalUnavailableException("RECOVERY_PREPARED_CHANNEL_MISMATCH");
            JournalStorageBinding.RequireSameContext(root.Binding,import.Prepared.Storage);
        }
        using var journalGuard=new JournalGuard(root,o.Journal,false,import?.Prepared.FileIdentity);
        // Automatic recovery owns a duplicate of the exact retained open object.
        // Only explicit --restore may open a separately authorized existing path.
        using var journal=import==null
            ? new FileRouteJournal(o.Journal,mustExist:true,validateHandle:journalGuard.Validate)
            : new FileRouteJournal(new SafeFileHandle(new IntPtr(import.HandleValue),true),
                handle=> { WindowsJournalHandleTransfer.ValidateFileHandle(handle); journalGuard.Validate(handle); },
                validateReadCommit:commit=>RunJournalProof.ValidateReadCommit(import.Prepared,commit));
        var record=journal.ReadLatest()??throw new RouteBlockedException("NO_TRANSACTION");
        if(import==null)
            WorkerChannel.PublishPrepared(journal,journalGuard,root,journal.ReadFirstCommit()??throw new JournalUnavailableException("EXPLICIT_RESTORE_FIRST_COMMIT_REQUIRED"),false);
        else WorkerChannel.AdoptRecoveryPrepared(import.Prepared);
        using var identity=new SpotifyIdentity(o.Pid.Value);
        using var audio=new AudioReadOnly();
        var resolver=new Win11SpotifyPolicyResolver(identity.Check,
            beforeSet:journal.ValidateStorage);
        if(import!=null) RequireAutomaticRecoveryIdentity(identity.Identity,record.CurrentProcess);
        var transaction=new OwnedRouteTransaction(resolver,audio,new PollObserver(()=>audio.Sessions(true),record.Target.Id,()=>Cancelled),journal);
        var restored=transaction.RecoverAndRestore(identity.Identity);
        var valuesMatch=false;
        if(restored.Stage is RouteStage.Restored or RouteStage.RolledBack)
        {
            var values=ReadAllOriginals(resolver,identity,restored);
            WorkerChannel.EmitTerminal(journal,journalGuard,values); valuesMatch=true;
        }
        Evidence.Emit("RECOVERY_RESULT",new { record=restored,policyOriginalsReadBack=valuesMatch,sessionReturnProved=false,journalRetained=true });
        return valuesMatch?5:4;
    }
}
