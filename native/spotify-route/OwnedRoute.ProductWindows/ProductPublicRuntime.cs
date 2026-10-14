using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Folia.ProductRoute;

namespace Folia.RouteRunner;

internal sealed record PublicSourceRequest(
    [property:JsonPropertyName("event")] string Event,string RequestId,string Action,string Session,int Generation,string SourceDeviceId,
    [property:JsonIgnore(Condition=JsonIgnoreCondition.Never)] string? ExpectedSourceUri,
    [property:JsonIgnore(Condition=JsonIgnoreCondition.Never)] string? PausedPreviousUri,bool AllowPreviousPaused,
    bool RequirePreparedSelection=false,string? PreparationSelectedSourceUri=null,
    bool RequirePreparationObservation=false,string? PreparationPhase=null,string? RestoreOperationId=null,
    bool AllowChangedTrackPausedForRestore=false,bool AllowEmptyPlayerForRestore=false, string? PausedProofTransferId=null, string? ResumeIntentId=null, bool PausedProofTransferFallback=false, bool RequireSeekParkEvidence=false, string? SeekTransaction=null, string? SeekToken=null, int SourceEpoch=1);

// Public Electron pipe and private native worker pipe have separate readers and
// frame types. Source replies bypass the ordinary serialized command queue so a
// pending acquire can request fresh source proof without deadlocking that queue.
internal sealed class ProductPublicRuntime(ProductCapabilities capabilities,TextReader? input=null,TextWriter? writer=null,
    Func<Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>>,CancellationToken,Task<IProductSupervisorProcess>>? createWorker=null,
    TimeSpan? requestBudget=null):IAsyncDisposable
{
    // Recovered dev11 keeps the public request at 30 seconds. Stop and recovery
    // have independent compensation budgets in ProductProcessSupervisor.
    internal static readonly TimeSpan RequestBudget=TimeSpan.FromSeconds(30);
    private readonly TimeSpan boundedRequestBudget=ValidateBudget(requestBudget);
    private readonly Channel<string> requests=Channel.CreateBounded<string>(new BoundedChannelOptions(8){SingleReader=true,SingleWriter=true,FullMode=BoundedChannelFullMode.Wait});
    private readonly ConcurrentDictionary<string,TaskCompletionSource<PlaybackStatus>> sourceReplies=new(StringComparer.Ordinal);
    private readonly object sourceGate=new();
    private readonly HashSet<string> retiredSourceReplies=new(StringComparer.Ordinal);
    private readonly CancellationTokenSource shutdown=new();
    private readonly SemaphoreSlim output=new(1,1);
    private IProductSupervisorProcess? worker;
    private readonly TextReader publicInput=input??Console.In;
    private readonly TextWriter publicOutput=writer??Console.Out;
    private bool everAcquired,restored,closed,workerAcquireRequested;
    private ProductDefaultStatus? lastDefaults;
    private object? lastLease;
    private Task? reader,inspectionCleanup;
    internal async Task<int> Run()
    {
        reader=Task.Run(ReadPublic);
        try
        {
            await foreach(var line in requests.Reader.ReadAllAsync(shutdown.Token).ConfigureAwait(false))
            {
                using var doc=JsonDocument.Parse(line);
                var root=doc.RootElement;
                var id=Id(root.GetProperty("id"));
                var command=root.GetProperty("command").GetString()??throw new InvalidDataException("COMMAND_REQUIRED");
                if(command is "hello" or "capabilities")
                {
                    await Emit(new ServiceReply(id,true,capabilities.Supported?"idle":"unsupported","CAPABILITIES",Capabilities:capabilities));continue;
                }
                if(command is "close" or "shutdown")
                {
                    var reply=await Close(id).ConfigureAwait(false);await Emit(reply).ConfigureAwait(false);closed=true;return reply.Ok?0:4;
                }
                if(inspectionCleanup is not null)
                {
                    // Do not charge a new command for an earlier worker's stop
                    // budget. Failed cleanup retains its owner until close.
                    if(!inspectionCleanup.IsCompleted||worker is not null)
                    {await Emit(new ServiceReply(id,false,"busy","ROUTE_BUSY")).ConfigureAwait(false);continue;}
                    inspectionCleanup=null;
                }
                if(!capabilities.CanOperate)
                {
                    await Emit(new ServiceReply(id,false,"unsupported","NATIVE_PRODUCT_ADAPTER_UNQUALIFIED",Capabilities:capabilities));continue;
                }
                if(worker is null)
                {
                    try
                    {
                        worker=createWorker is null?await ProductProcessSupervisor.Start(SourceRequest,shutdown.Token).ConfigureAwait(false):await createWorker(SourceRequest,shutdown.Token).ConfigureAwait(false);
                        workerAcquireRequested=false;
                    }
                    catch(Exception error)
                    {
                        // A failed factory has received no public worker command
                        // and cannot have granted Prepared mutation authority.
                        // Keep the parent available for an explicit later retry.
                        await Emit(new ServiceReply(id,false,"closed","NO_POLICY_WRITES",NoPolicyWrites:true,
                            FailureCode:PublicFailureCode(error.Message),OperationFailureDiagnostic:OperationFailureDiagnosticProjection.FromException("worker-start",error))).ConfigureAwait(false);
                        continue;
                    }
                }
                if(command=="acquire"){workerAcquireRequested=true;everAcquired=true;restored=false;lastDefaults=null;lastLease=null;}
                ServiceReply response;
                var retireFailedInspection=false;
                try {response=await Request(line,shutdown.Token).ConfigureAwait(false);}
                catch(Exception error)
                {
                    response=new(id,false,"recoveryRequired","PRODUCT_OPERATION_FAILED",
                        Lease:workerAcquireRequested?worker.RetainedLeaseReceipt??lastLease:null,
                        OperationFailureDiagnostic:command=="inspect"?OperationFailureDiagnosticProjection.FromException("inspect-request",error):null);
                    retireFailedInspection=command=="inspect"&&!workerAcquireRequested;
                }
                if(command=="acquire"&&response.Lease is not null)lastLease=response.Lease;
                // Recovered dev11: a bounded pre-write restore failure keeps its
                // exact worker/lease for an explicit retry; no cancel or recovery.
                if(command=="release"&&response.CleanupRetryable&&!response.Ok&&response.State=="recoveryRequired"&&
                    response.RestoreWritesStarted==false&&response.Lease is not null)
                {
                    await Emit(response with{Id=id}).ConfigureAwait(false);
                    continue;
                }
                if(command=="release"||command=="acquire"&&!response.Ok)
                {
                    // A source-pause rejection can be recoverable while the main
                    // broker remains alive. Keep that narrow authority through one
                    // graceful cleanup and retained-handle recovery attempt.
                    var acquisitionFailed=command=="acquire";
                    var failureCode=acquisitionFailed?PublicFailureCode(response.Code):null;
                    var physicalOwnerDiagnostic=acquisitionFailed?PhysicalOwnerDiagnosticProjection.FromFailure(failureCode,response.PhysicalOwnerDiagnostic):null;
                    // Stop sends authenticated cancel and keeps the source/ACK
                    // channel alive for the worker's own compensation. A second
                    // close command would duplicate its budget and can queue
                    // behind the very command that just timed out.
                    var outcome=await worker.Stop().ConfigureAwait(false);
                    if(outcome.Exited&&outcome.RecoveryRequired)
                    {
                        try {outcome=await worker.RecoverOnce().ConfigureAwait(false);}catch(Exception error){RouteRecoveryDiagnostic.Record("route.recovery-supervisor-failed",error);}
                    }
                    lastDefaults=worker.TerminalDefaults;
                    if(outcome.TerminalValidated&&outcome.Exited&&outcome.ExitCode==0&&lastDefaults is not null)
                    {
                        restored=true;
                        response=new(id,!acquisitionFailed,"restored",acquisitionFailed?"ACQUIRE_FAILED_RESTORED":"RELEASED",Lease:RestoredLease(response.Lease??lastLease??worker.RetainedLeaseReceipt),
                            ExactOriginalRolesRestored:true,DefaultsUnchanged:lastDefaults.Unchanged,Defaults:lastDefaults,
                            ObservedDefaultsChanged:!lastDefaults.Unchanged,FailureCode:failureCode,PhysicalOwnerDiagnostic:physicalOwnerDiagnostic);
                        await worker.DisposeAsync().ConfigureAwait(false);worker=null;
                    }
                    else if(outcome.NoPolicyWrites)
                    {
                        restored=false;everAcquired=false;
                        response=new(id,!acquisitionFailed,"closed","NO_POLICY_WRITES",NoPolicyWrites:true,FailureCode:failureCode,PhysicalOwnerDiagnostic:physicalOwnerDiagnostic);
                        await worker.DisposeAsync().ConfigureAwait(false);worker=null;
                    }
                    else response=new(id,false,"recoveryRequired","PRODUCT_RESTORE_UNCONFIRMED",Lease:response.Lease??lastLease,
                        Defaults:lastDefaults,ObservedDefaultsChanged:lastDefaults is null?null:!lastDefaults.Unchanged,FailureCode:failureCode,PhysicalOwnerDiagnostic:physicalOwnerDiagnostic);
                }
                await Emit(response with{Id=id}).ConfigureAwait(false);
                // Reply within the original inspect deadline. One owned cleanup
                // task blocks new operations with ROUTE_BUSY; it never replays
                // inspect, delays a new request behind stop, or overlaps workers.
                if(retireFailedInspection)inspectionCleanup=RetireFailedInspectionWorker();
            }
            var eof=await Close(null).ConfigureAwait(false);closed=true;return eof.Ok?0:4;
        }
        catch
        {
            var end=await Close(null).ConfigureAwait(false);closed=true;
            try {await Emit(end with{Ok=false,Code="PRODUCT_PUBLIC_CHANNEL_FAILED"}).ConfigureAwait(false);}catch{}
            return 4;
        }
    }
    // An inspect-only worker has never received acquire. Still require confirmed
    // exit and the supervisor's independent no-Prepared result before discarding
    // it. Once acquire was requested, normal retained-journal cleanup owns it.
    private async Task RetireFailedInspectionWorker()
    {
        var failed=worker;
        if(failed is null||workerAcquireRequested)return;
        try
        {
            var outcome=await failed.Stop().ConfigureAwait(false);
            if(!outcome.Exited||!outcome.NoPolicyWrites||outcome.RecoveryRequired||outcome.TerminalValidated
                ||failed.RetainedLeaseReceipt is not null)return;
            await failed.DisposeAsync().ConfigureAwait(false);
            worker=null;
        }
        catch { /* Unconfirmed cleanup retains the exact owner for close. */ }
    }
    private static string PublicFailureCode(string? value)
    {
        // Native exception messages can contain paths and diagnostic detail.
        // Prefix extraction alone is not sanitization: only this fixed enum is
        // public, and every unknown value becomes the same generic failure.
        var code=value?.Split(':',2)[0];
        return code switch
        {
            "NATIVE_PRODUCT_ADAPTER_UNQUALIFIED" or "PRODUCT_DISCOVERY_UNQUALIFIED" or
            "EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN" or "SPOTIFY_AUDIO_PROCESS_AMBIGUOUS" or
            "SPOTIFY_DISCOVERY_TIMEOUT" or "COMPLETE_SPOTIFY_DISCOVERY_REQUIRED" or
            "SPOTIFY_INSTANCE_CHANGED" or "SPOTIFY_CANDIDATE_SET_CHANGED" or
            "ORIGINAL_POLICY_VALUES_INVALID" or "ORIGINAL_POLICY_ENDPOINT_UNRESOLVED" or
            "ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS" or "ORIGINAL_ENDPOINT_UNSAFE" or
            "ORIGINAL_PHYSICAL_OWNER_UNPROVEN" or "ORIGINAL_EXPLICIT_ENDPOINT_CHANGED" or
            "ORIGINAL_POLICY_PROOF_REQUIRED" or "RECOVERY_ORIGINAL_BINDING_REQUIRED" or
            "NON_BASE_DEFAULT_OUTPUT_REQUIRED" or "ORIGINAL_ACTIVE_RENDER_OUTSIDE_BASE_UNPROVEN" or
            "INSPECTED_ORIGINALS_CHANGED" or "POLICY_CHANGED_BEFORE_APPLY" or "EXTERNAL_POLICY_CONFLICT" or
            "COMMUNICATIONS_POLICY_CHANGED" or "EXACT_BASE_PAIR_REQUIRED" or
            "EXACT_BASE_CAPTURE_RENDER_OWNER_MISMATCH" or "BASE_PAIR_CHANGED" or "BASE_OTHER_WRITER_PRESENT" or
            "SOURCE_PAUSE_CONFIRMATION_REQUIRED" or "SOURCE_NOT_PAUSED" or "SOURCE_TRACK_CHANGED" or
            "SOURCE_STATUS_DEVICE_OR_FRESHNESS_MISMATCH" or "SOURCE_RESUMED_DURING_PAUSE_PROOF" or
            "PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED" or "PCM_STOP_NOT_CONFIRMED" or
            "SOURCE_BROKER_UNAVAILABLE" or "SOURCE_BROKER_FAILED" or "SOURCE_STATUS_REQUIRED" or
            "SOURCE_PAUSE_NOT_CONFIRMED" or "SOURCE_PAUSE_DEVICE_MISMATCH" or
            "RECOVERY_PLAYBACK_OWNERSHIP_UNCONFIRMED" or "PRODUCT_CONTROL_AUTHORITY_LOST" or
            "PRODUCT_PARENT_APPLY_AUTHORITY_LOST" or "SUPERVISOR_CANCELLED" or
            "APPLY_READBACK_MISMATCH" or "RESTORE_READBACK_MISMATCH" or "SESSION_OBSERVATION_UNTRUSTED" or
            "JOURNAL_COMMIT_FAILED_NO_MORE_POLICY_WRITES" or "PRODUCT_PREPARED_ACK_MISMATCH" or
            "PREPARED_RETAIN_ACK_INVALID" or "JOURNAL_STORAGE_IDENTITY_UNSAFE" or
            "PRODUCT_JOURNAL_PARENT_VOLUME_CHANGED" or "PRODUCT_JOURNAL_EXISTING_ROOT_UNREACHABLE" or
            "PRODUCT_JOURNAL_FIXED_LOCAL_ROOT_REQUIRED" or "PRODUCT_JOURNAL_PARENT_REQUIRED" or
            "PRODUCT_JOURNAL_PARENT_OPEN_FAILED" or "PRODUCT_JOURNAL_ROOT_CREATE_FAILED" or
            "PRODUCT_JOURNAL_CREATED_HANDLE_REQUIRED" or "WINDOWS_PRODUCT_JOURNAL_REQUIRED" or "JOURNAL_SECURITY_CHANGED" or
            "PAUSED_PROOF_TRANSFER_INVALID" or "PAUSED_PROOF_TRANSFER_EXPIRED" or "PAUSED_PROOF_TRANSFER_SUPERSEDED" or "PAUSED_PROOF_TRANSFER_UNSUPPORTED" or
            "SEEK_PARK_UNSUPPORTED" or "SEEK_PARK_RECEIPT_INVALID" or "SEEK_PARK_EXPIRED" or "SEEK_PARK_STATE_INVALID" or
            "SEEK_PARK_TOKEN_INVALID" or "SEEK_PARK_EVIDENCE_REQUIRED" or "SEEK_PARK_EVIDENCE_FORBIDDEN" or "SEEK_PARK_KEEPER_CHANGED" or
            "SEEK_PARK_REBIND_OBSERVATION_INVALID" or "SOURCE_EPOCH_MISMATCH" => code,
            _=>"PRODUCT_OPERATION_FAILED"
        };
    }
    private static TimeSpan ValidateBudget(TimeSpan? requested)
    {
        var value=requested??RequestBudget;
        if(value<=TimeSpan.Zero||value>RequestBudget)throw new ArgumentOutOfRangeException(nameof(requested));
        return value;
    }
    private async Task<ServiceReply> Request(string line,CancellationToken cancellationToken)
    {
        using var deadline=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(boundedRequestBudget);
        // Cancellation bounds the command; it must not cancel the independent
        // public input pump needed by graceful stop and retained recovery.
        return await worker!.Request(line,deadline.Token).ConfigureAwait(false);
    }
    private async Task ReadPublic()
    {
        try
        {
            while(!shutdown.IsCancellationRequested)
            {
                var line=await WireInput.ReadLine(publicInput,16*1024,shutdown.Token).ConfigureAwait(false);
                if(line is null)break;
                using var doc=JsonDocument.Parse(line);
                var root=doc.RootElement;
                if(root.GetProperty("command").GetString()=="sourceControlResult")
                {
                    var id=root.GetProperty("id").GetString()??throw new InvalidDataException("SOURCE_RESPONSE_ID_REQUIRED");
                    TaskCompletionSource<PlaybackStatus>? pending;
                    lock(sourceGate)
                    {
                        if(!sourceReplies.TryRemove(id,out pending))
                        {
                            // A caller deadline can retire this exact request
                            // just before main's bounded response arrives. Drop
                            // it once; never bind it to a later source request.
                            if(retiredSourceReplies.Remove(id))continue;
                            throw new InvalidDataException("UNEXPECTED_SOURCE_RESPONSE");
                        }
                    }
                    var payload=root.GetProperty("payload");
                    if(!payload.GetProperty("ok").GetBoolean())
                    {pending.TrySetException(new IOException("SOURCE_BROKER_REJECTED"));continue;}
                    if(!ValidPlaybackShape(payload))
                    {pending.TrySetException(new InvalidDataException("SOURCE_RESPONSE_INVALID"));continue;}
                    var source=new PlaybackStatus(payload.GetProperty("sourceDeviceId").GetString()??"",
                        payload.GetProperty("trackUri").ValueKind==JsonValueKind.Null?null:payload.GetProperty("trackUri").GetString(),
                        OptionalFlag(payload,"isPlaying"),payload.GetProperty("observedAtUtc").GetDateTimeOffset(),
                        payload.TryGetProperty("pcmStopped",out var stopped)&&stopped.ValueKind==JsonValueKind.True,
                        payload.TryGetProperty("preparationOwned",out var prepared)&&prepared.ValueKind==JsonValueKind.True,
                        OptionalFlag(payload,"playbackRequestPending"),OptionalInteger(payload,"observationGeneration"),
                        OptionalInteger(payload,"mutationEpoch"),
                        payload.TryGetProperty("preparationPhase",out var phase)&&phase.ValueKind==JsonValueKind.String?phase.GetString():null,
                        OptionalInteger(payload,"positionMs"),
                        payload.TryGetProperty("restoreOperationId",out var restore)&&restore.ValueKind==JsonValueKind.String?restore.GetString():null,
                        OptionalFlag(payload,"emptyPlayer")==true, OptionalFlag(payload,"pausedProofTransferSuperseded")==true, payload.TryGetProperty("captureParkReceipt", out var parkReceipt) && parkReceipt.ValueKind != JsonValueKind.Null ? OwnedSeekParkReceipt.Read(parkReceipt) : null);
                    pending.TrySetResult(source);continue;
                }
                if(!requests.Writer.TryWrite(line))throw new InvalidDataException("PUBLIC_REQUEST_QUEUE_LIMIT");
            }
        }
        catch(Exception e) {requests.Writer.TryComplete(e);}
        finally
        {
            requests.Writer.TryComplete();
            foreach(var item in sourceReplies.Values)item.TrySetException(new EndOfStreamException("PUBLIC_SOURCE_BROKER_LOST"));
        }
    }
    private async Task<PlaybackStatus> SourceRequest(ProductSourceRequest request,CancellationToken cancellationToken)
    {
        if(request.Action is not ("read" or "pause"))throw new InvalidDataException("SOURCE_REQUEST_INVALID");
        // The dev13 restore-only relaxation cannot authorize a pause or inherit
        // prepared-selection authority. The native verifier checks paused/PCM
        // evidence and the exact operation before any restoration setter.
        if((request.Target.AllowChangedTrackPausedForRestore||request.Target.AllowEmptyPlayerForRestore)&&
            (request.Action!="read"||!request.Target.RequirePcmStopped||!Guid.TryParseExact(request.Target.RestoreOperationId,"D",out _)||
             request.Target.RequirePreparedSelection||request.Target.RequirePreparationObservation||
             request.Target.PreparationSelectedSourceUri is not null||request.Target.PreparationPhase is not null))
            throw new InvalidDataException("SOURCE_RESTORE_READ_SCOPE_INVALID");
        var pending=new TaskCompletionSource<PlaybackStatus>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock(sourceGate)
        {
            if(sourceReplies.Count!=0||retiredSourceReplies.Count>=8192)throw new InvalidDataException("SOURCE_REQUEST_LIMIT");
            if(retiredSourceReplies.Contains(request.RequestId)||!sourceReplies.TryAdd(request.RequestId,pending))throw new InvalidDataException("SOURCE_REQUEST_REPLAY");
        }
        try
        {
            await Emit(new PublicSourceRequest("sourceControl",request.RequestId,request.Action,request.Session,request.Generation,
                request.Target.DeviceId,request.Target.TrackUri,request.Target.PausedPreviousTrackUri,request.Target.AllowPreviousPaused,
                request.Target.RequirePreparedSelection,request.Target.PreparationSelectedSourceUri,
                request.Target.RequirePreparationObservation,request.Target.PreparationPhase,request.Target.RestoreOperationId,
                request.Target.AllowChangedTrackPausedForRestore,request.Target.AllowEmptyPlayerForRestore, request.Target.PausedProofTransferId, request.Target.ResumeIntentId, request.Target.PausedProofTransferFallback, request.Target.RequireSeekParkEvidence, request.Target.SeekParkReceipt?.SeekTransaction, request.Target.SeekParkReceipt?.SeekToken, request.Target.SourceEpoch)).ConfigureAwait(false);
            var result=await pending.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            if(result.EmptyPlayer&&(!request.Target.AllowEmptyPlayerForRestore||request.Action!="read"
                ||result.IsPlaying is not null||result.TrackUri is not null||result.PositionMs is not null
                ||!result.PcmStopped||result.PlaybackRequestPending!=false||result.RestoreOperationId!=request.Target.RestoreOperationId))
                throw new InvalidDataException("EMPTY_PLAYER_RESTORE_SCOPE_INVALID");
            return result;
        }
        finally
        {
            lock(sourceGate)
                if(sourceReplies.TryRemove(request.RequestId,out _))retiredSourceReplies.Add(request.RequestId);
        }
    }
    // Recovered dev11 optional source observation fields. Missing evidence stays
    // unknown instead of silently becoming a successful preparation observation.
    private static long? OptionalInteger(JsonElement value,string key)=>
        value.TryGetProperty(key,out var item)&&item.ValueKind==JsonValueKind.Number&&item.TryGetInt64(out var number)?number:null;
    private static bool ValidPlaybackShape(JsonElement value)
    {
        if(!value.TryGetProperty("isPlaying",out var playing))return false;
        if(!value.TryGetProperty("emptyPlayer",out var empty)||empty.ValueKind==JsonValueKind.False)
            return playing.ValueKind is JsonValueKind.True or JsonValueKind.False;
        return empty.ValueKind==JsonValueKind.True&&playing.ValueKind==JsonValueKind.Null
            &&value.TryGetProperty("trackUri",out var track)&&track.ValueKind==JsonValueKind.Null
            &&value.TryGetProperty("positionMs",out var position)&&position.ValueKind==JsonValueKind.Null;
    }
    private static bool? OptionalFlag(JsonElement value,string key)=>
        value.TryGetProperty(key,out var item)&&item.ValueKind is JsonValueKind.True or JsonValueKind.False?item.GetBoolean():null;
    private async Task<ServiceReply> Close(object? id)
    {
        if(inspectionCleanup is not null)await inspectionCleanup.ConfigureAwait(false);
        if(worker is null)return new(id,!everAcquired||restored,!everAcquired||restored?"closed":"recoveryRequired",everAcquired?restored?"RESTORED":"PRODUCT_RESTORE_UNCONFIRMED":"NO_POLICY_WRITES",Lease:restored?RestoredLease(lastLease):null,ExactOriginalRolesRestored:restored,DefaultsUnchanged:lastDefaults?.Unchanged??false,Defaults:lastDefaults,ObservedDefaultsChanged:lastDefaults is null?null:!lastDefaults.Unchanged,NoPolicyWrites:!everAcquired);
        try {await Request(JsonSerializer.Serialize(new{id="internal-close",command="close",payload=new{}}),CancellationToken.None).ConfigureAwait(false);}catch{}
        var outcome=await worker.Stop().ConfigureAwait(false);
        if(outcome.Exited&&outcome.RecoveryRequired)
        {
            try
            {
                outcome=await worker.RecoverOnce().ConfigureAwait(false);
            }
            catch (Exception error) { RouteRecoveryDiagnostic.Record("route.close-recovery-failed",error); }
        }
        lastDefaults=worker.TerminalDefaults;
        var noWrites=outcome.Exited&&outcome.NoPolicyWrites;
        // The ordinary reply can be lost while cancel grace finishes exact
        // compensation. Only retained terminal proof, complete default evidence
        // and confirmed clean exit can establish success in that case.
        var clean=outcome.Exited&&(noWrites||outcome.ExitCode==0&&outcome.TerminalValidated&&lastDefaults is not null);
        return new(id,clean,clean?"closed":"recoveryRequired",clean?noWrites?"NO_POLICY_WRITES":"RESTORED":"PRODUCT_RESTORE_UNCONFIRMED",
            Lease:clean&&!noWrites?RestoredLease(worker.RetainedLeaseReceipt??lastLease):null,
            ExactOriginalRolesRestored:clean&&!noWrites,DefaultsUnchanged:lastDefaults?.Unchanged??false,Defaults:lastDefaults,ObservedDefaultsChanged:lastDefaults is null?null:!lastDefaults.Unchanged,NoPolicyWrites:noWrites);
    }
    private static object? RestoredLease(object? lease)
    {
        if(lease is null)return null;
        var value=JsonSerializer.SerializeToNode(lease,WireJson.Options) as JsonObject;
        if(value is null)return null;value["state"]="restored";value["ready"]=false;return value;
    }
    private async Task Emit(object value)
    {
        // Validate again at the public boundary, including deserialized worker
        // replies. No native identity or arbitrary string is a diagnostic field.
        if(value is ServiceReply reply)value=reply with
        {
            PhysicalOwnerDiagnostic=reply.Ok?null:PhysicalOwnerDiagnosticProjection.FromFailure(reply.FailureCode??reply.Code,reply.PhysicalOwnerDiagnostic),
            OperationFailureDiagnostic=reply.Ok?null:OperationFailureDiagnosticProjection.Project(reply.OperationFailureDiagnostic)
        };
        await output.WaitAsync().ConfigureAwait(false);
        try {await publicOutput.WriteLineAsync(JsonSerializer.Serialize(value,WireJson.Options)).ConfigureAwait(false);await publicOutput.FlushAsync().ConfigureAwait(false);}
        finally {output.Release();}
    }
    private static object Id(JsonElement id)=>id.ValueKind switch
    {JsonValueKind.String when id.GetString() is {Length:>0 and <=128} value=>value,JsonValueKind.Number when id.TryGetInt64(out var value)=>value,_=>throw new InvalidDataException("PUBLIC_ID_INVALID")};
    public async ValueTask DisposeAsync()
    {
        if(inspectionCleanup is not null)await inspectionCleanup.ConfigureAwait(false);
        if(!closed)await Close(null).ConfigureAwait(false);
        shutdown.Cancel();if(worker is not null)await worker.DisposeAsync().ConfigureAwait(false);
        if(reader is not null)try{await reader.WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);}catch{}
        shutdown.Dispose();output.Dispose();
    }
}
