using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Channels;
using Folia.ProductRoute;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

internal sealed record ProductPipeFrame(string Kind,string RunId,string Nonce,string? RequestId=null,
    string? Body=null,string? Hash=null,PreparedJournalReceipt? Prepared=null,TerminalJournalReceipt? Terminal=null,
    ProductSourceRequest? Source=null,string? Error=null,ProductRecoveryBaseline? Baseline=null,ProductDefaultStatus? Defaults=null);
internal sealed record ProductSourceRequest(string RequestId,string Action,string Session,int Generation,OwnedPlaybackTarget Target);
internal sealed record ProductRecoveryBaseline(string?[] GlobalDefaults,OwnedPlaybackTarget Source,RouteSelection Selection,string? LeaseId=null,OriginalPolicyBinding[]? OriginalDestinations=null);
internal sealed record ProductWorkerStart(string RunId,string Nonce,int ParentPid,long ParentStarted,
    string ParentImage,string UserSid,string JournalPath,JournalStorageBinding Storage, RecoveryJournalImport? Recovery=null,
    ProductRecoveryBaseline? Baseline=null,string? Session=null,int Generation=0);
internal sealed record ProductWorkerCommand(string Id,string Body);

// A private authenticated worker channel. One reader owns the pipe for commands,
// ACKs and cancellation; it stays responsive while synchronous policy/observer
// work executes on the worker thread. No public client JSON can become an ACK.
internal sealed class ProductWorkerChannel:IProductJournalChannel,IDisposable
{
    private readonly ProductWorkerStart start;
    private readonly TextReader input;
    private readonly TextWriter output;
    private readonly Action verifyParent;
    private readonly Channel<ProductWorkerCommand> commands=Channel.CreateBounded<ProductWorkerCommand>(new BoundedChannelOptions(8){SingleReader=true,SingleWriter=true,FullMode=BoundedChannelFullMode.Wait});
    private readonly object writeGate=new(),ackGate=new();
    private readonly CancellationTokenSource shutdown=new();
    private TaskCompletionSource<ProductPipeFrame>? pending;
    private string? pendingKind,pendingRequestId,session,leaseId;
    private int generation;
    private int authorityLost;
    private readonly Task pump;
    private ProductRecoveryBaseline? baseline;
    internal ProductWorkerChannel(ProductWorkerStart start,TextReader input,TextWriter output,Action verifyParent)
    {
        this.start=start;this.input=input;this.output=output;this.verifyParent=verifyParent;
        session=start.Session;generation=start.Generation;baseline=start.Baseline;leaseId=baseline?.LeaseId;
        if(!RunJournalProof.ValidHash(start.RunId)||!RunJournalProof.ValidHash(start.Nonce))throw new InvalidDataException("PRODUCT_PIPE_BINDING_INVALID");
        RequireParentAlive();pump=Task.Run(Pump);
    }
    public void BindLease(string session,int generation,string leaseId)
    {
        if(this.session!=session||this.generation!=generation||this.leaseId is not null||!Guid.TryParseExact(leaseId,"D",out _))
            throw new JournalUnavailableException("LEASE_CHANNEL_BINDING_INVALID");
        this.leaseId=leaseId;
    }
    public void SetRecoveryBaseline(ProductRecoveryBaseline value)
    {
        value=value with{LeaseId=leaseId??throw new JournalUnavailableException("LEASE_CHANNEL_BINDING_REQUIRED")};
        if(value.GlobalDefaults.Length!=6||value.Source.Process.UserSid!=start.UserSid)throw new JournalUnavailableException("RECOVERY_BASELINE_INVALID");
        if(baseline is not null && JsonSerializer.Serialize(baseline)!=JsonSerializer.Serialize(value))throw new JournalUnavailableException("RECOVERY_BASELINE_CHANGED");
        baseline=value with{GlobalDefaults=value.GlobalDefaults.ToArray(),OriginalDestinations=value.OriginalDestinations?.ToArray()};
    }
    public string RunId=>start.RunId;
    public string JournalPath=>start.JournalPath;
    public JournalStorageBinding Storage=>start.Storage;
    internal ChannelReader<ProductWorkerCommand> Commands=>commands.Reader;
    internal bool ApplyAuthorityLost=>Volatile.Read(ref authorityLost)!=0;
    public void RequireParentAlive()
    {
        if(ApplyAuthorityLost)throw new RouteBlockedException("PRODUCT_CONTROL_AUTHORITY_LOST");
        verifyParent();
    }
    public string PublishPreparedAndAwaitRetainedAck(PreparedJournalReceipt receipt,TimeSpan deadline)
    {
        RequireParentAlive();
        if(receipt.RunId!=RunId)throw new JournalUnavailableException("PRODUCT_PREPARED_RUN_MISMATCH");
        var reply=Exchange("prepared-ack",new("prepared",RunId,start.Nonce,Prepared:receipt,Baseline:baseline??throw new JournalUnavailableException("RECOVERY_BASELINE_REQUIRED")),deadline);
        return reply.Hash??throw new JournalUnavailableException("PRODUCT_PREPARED_ACK_HASH_REQUIRED");
    }
    public void PublishTerminalAndAwaitAcceptance(TerminalJournalReceipt receipt,ProductDefaultStatus defaults,TimeSpan deadline)
    {
        // The terminal frame follows local durable compensation. A lost parent
        // must not prevent those preceding writes; delivery failure stays unknown.
        var reply=Exchange("terminal-ack",new("terminal",RunId,start.Nonce,Terminal:receipt,Defaults:defaults),deadline);
        if(reply.Hash!=receipt.Terminal.FrameHash)throw new JournalUnavailableException("PRODUCT_TERMINAL_ACK_HASH_MISMATCH");
    }
    internal ISourcePlaybackControl CreateSourceControl(OwnedPlaybackTarget target)=>new SourceControl(this,target);
    private PlaybackStatus Source(string action,OwnedPlaybackTarget target,TimeSpan budget)
    {
        if(string.IsNullOrEmpty(session)||generation<=0)throw new RouteBlockedException("SOURCE_SESSION_BINDING_REQUIRED");
        var id="source-"+Guid.NewGuid().ToString("D");
        var request=new ProductSourceRequest(id,action,session,generation,target);
        ProductPipeFrame reply;
        try {reply=Exchange("source-reply",new("source",RunId,start.Nonce,id,Source:request),budget);}
        catch(Exception e) {throw new RouteBlockedException("SOURCE_BROKER_UNAVAILABLE:"+e.GetType().Name);}
        if(reply.Error is not null)throw new RouteBlockedException("SOURCE_BROKER_FAILED:"+reply.Error);
        return JsonSerializer.Deserialize<PlaybackStatus>(reply.Body??"")??throw new RouteBlockedException("SOURCE_STATUS_REQUIRED");
    }
    private sealed class SourceControl(ProductWorkerChannel owner,OwnedPlaybackTarget target):ISourcePlaybackControl
    {
        public PlaybackStatus ReadFresh(TimeSpan budget)=>owner.Source("read",target,budget);
        public void PauseExactDevice(string deviceId,TimeSpan budget)
        {
            if(deviceId!=target.DeviceId)throw new RouteBlockedException("SOURCE_PAUSE_DEVICE_MISMATCH");
            if(owner.Source("pause",target,budget).IsPlaying != false)throw new RouteBlockedException("SOURCE_PAUSE_NOT_CONFIRMED");
        }
    }
    internal void Reply(string id,ServiceReply value)=>Write(new("reply",RunId,start.Nonce,id,JsonSerializer.Serialize(value,WireJson.Options)));
    private ProductPipeFrame Exchange(string kind,ProductPipeFrame outgoing,TimeSpan deadline)
    {
        // Recovered dev11 ProductWorkerChannel.Exchange: source operations have
        // their own bounded budget; journal ACKs still expire after two seconds.
        var maximum=kind=="source-reply"?TimeSpan.FromSeconds(outgoing.Source?.Action=="pause"?12:6):TimeSpan.FromSeconds(2);
        if(deadline<=TimeSpan.Zero||deadline>maximum)throw new ArgumentOutOfRangeException(nameof(deadline));
        Task<ProductPipeFrame> waiting;
        lock(ackGate)
        {
            if(pending is not null)throw new JournalUnavailableException("PRODUCT_ACK_ALREADY_PENDING");
            pendingKind=kind;pendingRequestId=outgoing.RequestId;pending=new(TaskCreationOptions.RunContinuationsAsynchronously);waiting=pending.Task;
        }
        try
        {
            Write(outgoing);
            if(!waiting.Wait(deadline))throw new JournalUnavailableException("PRODUCT_ACK_TIMEOUT");
            return waiting.GetAwaiter().GetResult();
        }
        finally {lock(ackGate){pending=null;pendingKind=null;pendingRequestId=null;}}
    }
    private async Task Pump()
    {
        try
        {
            while(!shutdown.IsCancellationRequested)
            {
                var line=await WireInput.ReadLine(input,128*1024,shutdown.Token).ConfigureAwait(false);
                if(line is null)break;
                var frame=JsonSerializer.Deserialize<ProductPipeFrame>(line)??throw new InvalidDataException("PRODUCT_FRAME_REQUIRED");
                if(frame.RunId!=RunId||frame.Nonce!=start.Nonce)throw new InvalidDataException("PRODUCT_PIPE_AUTHENTICATION_MISMATCH");
                if(frame.Kind=="cancel") {LoseAuthority();commands.Writer.TryComplete();continue;}
                if(frame.Kind=="command")
                {
                    if(frame.Body is not null)
                    {
                        using var request=JsonDocument.Parse(frame.Body);
                        if(request.RootElement.GetProperty("command").GetString()=="acquire")
                        {
                            var payload=request.RootElement.GetProperty("payload");
                            session=payload.GetProperty("session").GetString();generation=payload.GetProperty("generation").GetInt32();
                        }
                    }
                    if(ApplyAuthorityLost||string.IsNullOrEmpty(frame.RequestId)||frame.RequestId.Length>128||frame.Body is null||frame.Body.Length>16384||
                        !commands.Writer.TryWrite(new(frame.RequestId,frame.Body)))throw new InvalidDataException("PRODUCT_COMMAND_QUEUE_OR_SHAPE_INVALID");
                    continue;
                }
                lock(ackGate)
                {
                    if(pending is null||frame.Kind!=pendingKind||frame.RequestId!=pendingRequestId||!pending.TrySetResult(frame))throw new InvalidDataException("PRODUCT_UNEXPECTED_ACK");
                }
            }
        }
        catch(Exception e) {lock(ackGate)pending?.TrySetException(e);}
        finally {LoseAuthority();commands.Writer.TryComplete();}
    }
    private void Write(ProductPipeFrame frame)
    {
        lock(writeGate)
        {
            try {output.WriteLine(JsonSerializer.Serialize(frame));output.Flush();}
            catch {LoseAuthority();throw;}
        }
    }
    private void LoseAuthority()
    {
        Interlocked.Exchange(ref authorityLost,1);
        lock(ackGate)pending?.TrySetException(new JournalUnavailableException("PRODUCT_CONTROL_CHANNEL_LOST"));
    }
    public void Dispose(){LoseAuthority();shutdown.Cancel();shutdown.Dispose();}
}
internal static class WireJson
{
    internal static readonly JsonSerializerOptions Options=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition=System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull};
}

internal static class ProductWorkerRuntime
{
    internal const string NonceVariable="FOLIA_PRODUCT_ROUTE_NONCE";
    // Called only by a future qualified composition's private --product-worker
    // entry point. There is no command-line argument for enabling route adapters.
    internal static async Task<int> Run(Func<IProductJournalChannel,IProductRouteBackend> compose,bool recovery=false,
        Func<ProductWorkerChannel,ProductWorkerStart,int>? recover=null)
    {
        if(!OperatingSystem.IsWindows()||!Console.IsInputRedirected)return 2;
        var nonce=Environment.GetEnvironmentVariable(NonceVariable);Environment.SetEnvironmentVariable(NonceVariable,null);
        if(nonce is null||!RunJournalProof.ValidHash(nonce))return 2;
        using var startup=new CancellationTokenSource(TimeSpan.FromSeconds(2));
        ProductWorkerStart start;
        try
        {
            var line=await WireInput.ReadLine(Console.In,128*1024,startup.Token).ConfigureAwait(false);
            start=JsonSerializer.Deserialize<ProductWorkerStart>(line??"")??throw new InvalidDataException();
            if(start.Nonce!=nonce||!RunJournalProof.ValidHash(start.RunId)||start.ParentImage!=Environment.ProcessPath||recovery!=(start.Recovery is not null))
                throw new InvalidDataException("PRODUCT_PARENT_IMAGE_MISMATCH");
        }
        catch {return 2;}
        using var parent=Process.GetProcessById(start.ParentPid);
        void Verify()
        {
            WindowsJournalHandleTransfer.Authenticate(parent,start.ParentStarted,start.UserSid);
            if(parent.SessionId!=Process.GetCurrentProcess().SessionId||
                !string.Equals(parent.MainModule?.FileName,start.ParentImage,StringComparison.OrdinalIgnoreCase))
                throw new RouteBlockedException("PRODUCT_PARENT_IDENTITY_MISMATCH");
        }
        using var channel=new ProductWorkerChannel(start,Console.In,Console.Out,Verify);
        var completion=new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var worker=new Thread(()=>
        {
            IProductRouteBackend? backend=null;
            try
            {
                if(recovery)
                {
                    completion.TrySetResult((recover??throw new InvalidOperationException("RECOVERY_COMPOSITION_REQUIRED"))(channel,start));return;
                }
                backend=compose(channel);
                using var service=new ProductRouteService(backend);
                try
                {
                    while(!service.Closed)
                    {
                        using var idle=new CancellationTokenSource();
                        if(service.HasLease)idle.CancelAfter(ProductRouteService.IdleLimit);
                        if(!channel.Commands.WaitToReadAsync(idle.Token).AsTask().GetAwaiter().GetResult())break;
                        if(!channel.Commands.TryRead(out var command))continue;
                        var reply=service.Dispatch(command.Body);channel.Reply(command.Id,reply);
                        if(service.Closed){completion.TrySetResult(reply.Ok?0:4);return;}
                    }
                    var terminal=service.Disconnect("OWNER_CHANNEL_EOF");completion.TrySetResult(terminal.Ok?0:4);
                }
                catch {service.Disconnect("PRODUCT_WORKER_CONTROL_FAILED");completion.TrySetResult(4);}
            }
            catch (Exception error) {RouteRecoveryDiagnostic.Record(recovery ? "route.recovery-worker-failed" : "route.worker-failed",error);completion.TrySetResult(4);}
            finally {(backend as IDisposable)?.Dispose();}
        }){IsBackground=true,Name="Folia product route MTA"};
        worker.SetApartmentState(ApartmentState.MTA);worker.Start();
        return await completion.Task.ConfigureAwait(false);
    }
}
