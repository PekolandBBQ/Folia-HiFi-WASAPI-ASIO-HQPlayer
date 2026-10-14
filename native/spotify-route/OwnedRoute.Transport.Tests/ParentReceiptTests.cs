using System.Text.Json;
using System.Text;
using System.Threading.Channels;
using Folia.ProductRoute;
using Folia.RouteRunner;

internal static class ParentReceiptTests
{
    internal static async Task<int> Run()
    {
        var count=0;
        async Task Test(string name,Func<Task> body){await body();count++;Console.WriteLine("PASS "+name);}
        foreach(var releasedFirst in new[]{false,true})
            await Test("restored close includes exact retained lease "+(releasedFirst?"after release":"with live worker"),async()=>
            {
                var child=new Child("close-receipt",3);
                var commands=new List<string>{Command("1","inspect"),Command("2","acquire","close-receipt",3)};
                if(releasedFirst)commands.Add(Command("release","release"));
                commands.Add(Command("close","close"));
                var (rows,code)=await Execute([child],commands.ToArray());
                var close=rows.Single(x=>x.GetProperty("id").GetString()=="close");
                var lease=close.GetProperty("lease");
                Require(code==0&&close.GetProperty("exactOriginalRolesRestored").GetBoolean());
                Require(lease.GetProperty("leaseId").GetString()==child.LeaseId&&lease.GetProperty("session").GetString()=="close-receipt"&&
                    lease.GetProperty("generation").GetInt32()==3&&lease.GetProperty("state").GetString()=="restored"&&!lease.GetProperty("ready").GetBoolean());
            });
        await Test("retryable release before writes retains exact worker until explicit retry",async()=>
        {
            using var input=new PublicFeed();using var output=new PublicCapture();
            var child=new Child("retry",8){RetryFirstRelease=true};var starts=0;
            await using var runtime=new ProductPublicRuntime(new(true,true,true,true,true,[],IntervalIsolation:true),input,output,(_,_)=>
            {starts++;return Task.FromResult<IProductSupervisorProcess>(child);});
            var run=runtime.Run();input.Send(Command("acquire","acquire","retry",8));await output.Read();
            input.Send(Command("first-release","release"));var retry=await output.Read();
            Require(!retry.GetProperty("ok").GetBoolean()&&retry.GetProperty("cleanupRetryable").GetBoolean()&&
                !retry.GetProperty("restoreWritesStarted").GetBoolean()&&retry.GetProperty("lease").GetProperty("leaseId").GetString()==child.LeaseId);
            Require(child.StopRequests==0&&child.RecoveryLaunches==0&&!child.Disposed&&starts==1);
            input.Send(Command("heartbeat","heartbeat"));await output.Read();
            Require(child.StopRequests==0&&!child.Disposed&&starts==1);
            input.Send(Command("retry-release","release"));var restored=await output.Read();
            Require(restored.GetProperty("exactOriginalRolesRestored").GetBoolean()&&child.StopRequests==1&&child.Disposed&&starts==1);
            input.Send(Command("close","close"));Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0);
        });
        await Test("changed-track restore broker scope is read-only and operation-bound",async()=>
        {
            using var input=new PublicFeed();using var output=new PublicCapture();
            Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>>? broker=null;
            await using var runtime=new ProductPublicRuntime(new(true,true,true,true,true,[],IntervalIsolation:true),input,output,(source,_)=>
            {broker=source;return Task.FromResult<IProductSupervisorProcess>(new Child("restore-scope",1){NoWrites=true});});
            var run=runtime.Run();input.Send(Command("inspect","inspect"));await output.Read();
            var target=new OwnedPlaybackTarget("official","spotify:track:1111111111111111111111",new(7,8,"sid","policy","image","desktop"),
                RequirePcmStopped:true,RestoreOperationId:Guid.NewGuid().ToString("D"),AllowChangedTrackPausedForRestore:true);
            var invalid=new (string Action,OwnedPlaybackTarget Target)[]{("pause",target),("read",target with{RequirePcmStopped=false}),
                ("read",target with{RestoreOperationId=null}),("read",target with{RestoreOperationId="forged"}),
                ("read",target with{RequirePreparedSelection=true}),("read",target with{RequirePreparationObservation=true}),
                ("read",target with{PreparationPhase="baseline"}),("read",target with{PreparationSelectedSourceUri=target.TrackUri})};
            foreach(var item in invalid)
            {
                try{await broker!(new(Guid.NewGuid().ToString("D"),item.Action,"restore-scope",1,item.Target),CancellationToken.None);throw new Exception("Invalid restore read accepted");}
                catch(InvalidDataException error){Require(error.Message=="SOURCE_RESTORE_READ_SCOPE_INVALID");}
            }
            using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var response=broker!(new("valid-restore","read","restore-scope",1,target),timeout.Token);
            var request=await output.Read();
            Require(request.GetProperty("allowChangedTrackPausedForRestore").GetBoolean()&&request.GetProperty("action").GetString()=="read"&&
                request.GetProperty("restoreOperationId").GetString()==target.RestoreOperationId);
            input.Send(JsonSerializer.Serialize(new{id="valid-restore",command="sourceControlResult",payload=new{ok=true,sourceDeviceId="official",
                trackUri="spotify:track:2222222222222222222222",isPlaying=false,pcmStopped=true,observedAtUtc=DateTimeOffset.UtcNow,restoreOperationId=target.RestoreOperationId}}));
            var observed=await response;Require(observed.PcmStopped&&observed.IsPlaying==false&&observed.RestoreOperationId==target.RestoreOperationId);
            input.Send(Command("close","close"));Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0);
        });
        await Test("resume preparation advances retained scope only for validated same track",()=>
        {
            const string uri="spotify:track:1111111111111111111111";
            var target=new OwnedPlaybackTarget("official",uri,new(7,8,"sid","policy","image","desktop"));
            var baseline=new ProductRecoveryBaseline(new string?[6],target,new("capture","render"));
            var response=new ServiceReply("1",true,"preparedSelection","RESUME_PREPARATION_AUTHORIZED",PreparedSelectionAuthorized:true);
            JsonElement Payload(string selected)=>JsonSerializer.SerializeToElement(new{selectedSourceUri=selected});
            Require(ProductSourceRecoveryScope.Advance("resumePreparation",Payload(uri),response,baseline)?.Source==target);
            foreach(var bad in new[]{response with{Ready=true},response with{ResumeAuthorized=true},response with{IntervalArmed=true},
                response with{State="ready"},response with{PreparedSelectionAuthorized=false}})
            {
                try{ProductSourceRecoveryScope.Advance("resumePreparation",Payload(uri),bad,baseline);throw new Exception("Invalid resume preparation reply accepted");}
                catch(InvalidDataException){}
            }
            try{ProductSourceRecoveryScope.Advance("resumePreparation",Payload("spotify:track:2222222222222222222222"),response,baseline);throw new Exception("Changed resume track accepted");}
            catch(InvalidDataException error){Require(error.Message=="SOURCE_TRACK_CHANGED");}
            return Task.CompletedTask;
        });
        await Test("failed acquire with proven zero authority closes cleanly and permits explicit retry",async()=>
        {
            var first=new Child("first",1){AcquireThrows=true,NoWrites=true};var second=new Child("next",2){NoWrites=true};
            var (rows,code)=await Execute([first,second],[Command("1","inspect"),Command("2","acquire","first",1),Command("3","inspect"),Command("4","close")]);
            var rejected=rows.Single(x=>x.GetProperty("id").GetString()=="2");
            Require(!rejected.GetProperty("ok").GetBoolean()&&rejected.GetProperty("code").GetString()=="NO_POLICY_WRITES"&&rejected.GetProperty("noPolicyWrites").GetBoolean());
            Require(rows.Single(x=>x.GetProperty("id").GetString()=="3").GetProperty("ok").GetBoolean()&&first.RecoveryLaunches==0&&first.Disposed&&code==0);
        });
        await Test("prior restored lease cannot leak into next failed acquire recovery receipt",async()=>
        {
            var first=new Child("first",1);var second=new Child("second",2){AcquireThrows=true,NeedsRecovery=true};
            var (rows,code)=await Execute([first,second],[Command("1","inspect"),Command("2","acquire","first",1),Command("3","release"),Command("4","inspect"),Command("5","acquire","second",2),Command("6","close")]);
            var result=rows.Single(x=>x.GetProperty("id").GetString()=="5");var lease=result.GetProperty("lease");
            Require(!result.GetProperty("ok").GetBoolean()&&result.GetProperty("state").GetString()=="restored"&&result.GetProperty("exactOriginalRolesRestored").GetBoolean());
            Require(lease.GetProperty("session").GetString()=="second"&&lease.GetProperty("generation").GetInt32()==2&&lease.GetProperty("leaseId").GetString()==second.LeaseId);
            Require(lease.GetProperty("originalRoles")[0].GetProperty("original").ValueKind==JsonValueKind.Null&&second.RecoveryLaunches==1&&code==0);
        });
        await Test("unresolved accepted-Prepared acquire cannot become a no-write failure receipt",async()=>
        {
            var child=new Child("uncertain",1){AcquireThrows=true,NeedsRecovery=true,RecoveryFails=true};
            var (rows,code)=await Execute([child],[Command("1","inspect"),Command("2","acquire","uncertain",1),Command("3","close")]);
            var result=rows.Single(x=>x.GetProperty("id").GetString()=="2");
            Require(!result.GetProperty("ok").GetBoolean()&&result.GetProperty("state").GetString()=="recoveryRequired"&&!result.GetProperty("noPolicyWrites").GetBoolean());
            Require(child.RecoveryLaunches==1&&code==4);
        });
        await Test("failed acquire recovery returns exact mixed raw originals",async()=>
        {
            var child=new Child("mixed",4){AcquireThrows=true,NeedsRecovery=true,Originals=[null,"MiXeD-Raw-Explicit-USB"]};
            var (rows,code)=await Execute([child],[Command("1","inspect"),Command("2","acquire","mixed",4),Command("3","close")]);
            var result=rows.Single(x=>x.GetProperty("id").GetString()=="2");var roles=result.GetProperty("lease").GetProperty("originalRoles");
            Require(!result.GetProperty("ok").GetBoolean()&&result.GetProperty("exactOriginalRolesRestored").GetBoolean()&&code==0);
            Require(roles[0].GetProperty("original").ValueKind==JsonValueKind.Null&&roles[1].GetProperty("original").GetString()=="MiXeD-Raw-Explicit-USB");
        });
        await Test("timed out acquire skips another close budget and keeps broker alive through recovery",()=>BudgetCase("acquire"));
        await Test("hung close has one request deadline and keeps broker alive through stop and recovery",()=>BudgetCase("close"));
        await Test("timed out status defers cleanup until a scoped release with broker alive",()=>BudgetCase("status"));
        await Test("timed out heartbeat defers cleanup until a scoped release with broker alive",()=>BudgetCase("heartbeat"));
        await Test("lost close reply accepts independently validated terminal during cancel grace without a recovery",()=>BudgetCase("close",false));
        await Test("one late timed-out source reply cannot close the broker needed by retained recovery",()=>BudgetCase("close",true,true));
        await Test("a repeated retired source reply still fails the public channel without proving restoration",()=>BudgetCase("close",true,true,true));
        await Test("close terminal without complete default evidence stays unresolved",async()=>
        {
            var child=new Child("missing-defaults",1){MissingDefaults=true};
            var (rows,code)=await Execute([child],[Command("1","inspect"),Command("2","acquire","missing-defaults",1),Command("3","close")]);
            var result=rows.Single(x=>x.GetProperty("id").GetString()=="3");
            Require(!result.GetProperty("ok").GetBoolean()&&!result.GetProperty("exactOriginalRolesRestored").GetBoolean()&&code==4);
        });
        foreach(var noWrites in new[]{true,false})
            await Test("failed acquire preserves only fixed safe cause beside "+(noWrites?"no-write":"restored")+" proof",async()=>
            {
                foreach(var (raw,expected) in new[]{("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED","ORIGINAL_EXPLICIT_ENDPOINT_CHANGED"),
                    ("SOURCE_BROKER_FAILED:private path and token","SOURCE_BROKER_FAILED"),
                    ("UNKNOWN_PRIVATE_ENUM:private path and token","PRODUCT_OPERATION_FAILED")})
                {
                    var child=new Child("cause",1){AcquireCode=raw,NoWrites=noWrites,NeedsRecovery=!noWrites};
                    var (rows,exitCode)=await Execute([child],[Command("1","inspect"),Command("2","acquire","cause",1),Command("3","close")]);
                    var result=rows.Single(x=>x.GetProperty("id").GetString()=="2");
                    Require(exitCode==0&&!result.GetProperty("ok").GetBoolean()&&result.GetProperty("failureCode").GetString()==expected);
                    Require(result.GetProperty("code").GetString()==(noWrites?"NO_POLICY_WRITES":"ACQUIRE_FAILED_RESTORED"));
                    Require(result.GetProperty("noPolicyWrites").GetBoolean()==noWrites&&result.GetProperty("exactOriginalRolesRestored").GetBoolean()==!noWrites);
                    Require(!result.GetRawText().Contains("private path",StringComparison.Ordinal)&&!result.GetRawText().Contains("UNKNOWN_PRIVATE_ENUM",StringComparison.Ordinal));
                }
            });
        await Test("fixed journal initialization failure reports no writes without closing the parent or leaking detail",async()=>
        {
            using var reader=new StringReader(string.Join('\n',new[]{Command("1","inspect"),Command("2","inspect"),Command("3","close")})+"\n");
            using var writer=new StringWriter();var starts=0;var child=new Child("unused",1){NoWrites=true};
            var caps=new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true);
            await using var runtime=new ProductPublicRuntime(caps,reader,writer,(_,_)=>
            {
                if(++starts==1)throw new IOException("PRODUCT_JOURNAL_PARENT_OPEN_FAILED:private path and token");
                return Task.FromResult<IProductSupervisorProcess>(child);
            });
            Require(await runtime.Run()==0);
            var rows=writer.ToString().Split('\n',StringSplitOptions.RemoveEmptyEntries).Select(value=>JsonSerializer.Deserialize<JsonElement>(value)).ToArray();
            Require(rows[0].GetProperty("code").GetString()=="NO_POLICY_WRITES"&&rows[0].GetProperty("noPolicyWrites").GetBoolean());
            Require(rows[0].GetProperty("failureCode").GetString()=="PRODUCT_JOURNAL_PARENT_OPEN_FAILED"&&!writer.ToString().Contains("private path",StringComparison.Ordinal));
            Require(starts==2&&rows[1].GetProperty("ok").GetBoolean());
        });
        return count;
    }
    private static async Task BudgetCase(string hangingCommand,bool recoveryRequired=true,bool lateSourceReply=false,bool replayLateSource=false)
    {
        using var input=new PublicFeed();using var output=new PublicCapture();
        var child=new Child("bounded",6){HangCommand=hangingCommand,NeedsRecovery=recoveryRequired};
        var caps=new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true);
        Func<ProductSourceRequest,CancellationToken,Task<PlaybackStatus>>? source=null;
        var proofCount=0;
        var sourceTimedOut=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task ProveSource(string stage)
        {
            // This request starts after the command deadline. The command's
            // cancellation must not cancel the public reader/source channel.
            using var limit=new CancellationTokenSource(TimeSpan.FromSeconds(2));
            var target=new OwnedPlaybackTarget("official","spotify:track:one",new(7,8,"S-test","policy","image","desktop"),RequirePcmStopped:true);
            var status=await source!(new(stage,"read","bounded",6,target),limit.Token);
            Require(status.DeviceId==target.DeviceId&&status.IsPlaying==false&&status.PcmStopped);proofCount++;
        }
        child.OnStop=async()=>
        {
            if(!lateSourceReply){await ProveSource("stop-proof");return;}
            using var deadline=new CancellationTokenSource(TimeSpan.FromMilliseconds(20));
            var target=new OwnedPlaybackTarget("official","spotify:track:one",new(7,8,"S-test","policy","image","desktop"),RequirePcmStopped:true);
            try{await source!(new("late-proof","read","bounded",6,target),deadline.Token);throw new Exception("Source unexpectedly completed");}
            catch(OperationCanceledException){sourceTimedOut.SetResult();}
        };
        child.OnRecovery=()=>ProveSource("recovery-proof");
        await using var runtime=new ProductPublicRuntime(caps,input,output,(broker,_)=>
        {source=broker;return Task.FromResult<IProductSupervisorProcess>(child);},TimeSpan.FromMilliseconds(20));
        var run=runtime.Run();
        input.Send(Command("1","inspect"));input.Send(Command("2","acquire","bounded",6));
        var activeFailure=hangingCommand is "status" or "heartbeat";
        if(hangingCommand!="acquire")input.Send(Command("3",hangingCommand));
        var seenFinal=false;
        while(!seenFinal)
        {
            var row=await output.Read();
            if(row.TryGetProperty("event",out var kind)&&kind.GetString()=="sourceControl")
            {
                if(row.GetProperty("requestId").GetString()=="late-proof")
                {
                    await sourceTimedOut.Task.WaitAsync(TimeSpan.FromSeconds(2));
                    // It must be discarded for this retired request only, never
                    // accepted as the new recovery request's pause evidence.
                    for(var attempt=0;attempt<(replayLateSource?2:1);attempt++)
                        input.Send(JsonSerializer.Serialize(new{id="late-proof",command="sourceControlResult",payload=new{ok=false}}));
                    continue;
                }
                input.Send(JsonSerializer.Serialize(new{id=row.GetProperty("requestId").GetString(),command="sourceControlResult",
                    payload=new{ok=true,sourceDeviceId="official",trackUri="spotify:track:one",isPlaying=false,pcmStopped=true,observedAtUtc=DateTimeOffset.UtcNow}}));
                continue;
            }
            if(activeFailure&&row.GetProperty("id").GetString()=="3")
            {
                Require(!row.GetProperty("ok").GetBoolean()&&row.GetProperty("state").GetString()=="recoveryRequired");
                Require(child.StopRequests==0&&child.RecoveryLaunches==0&&proofCount==0);
                input.Send(Command("4","release"));continue;
            }
            if(row.GetProperty("id").GetString()==(activeFailure?"4":hangingCommand=="close"?"3":"2"))
            {
                Require(row.GetProperty("exactOriginalRolesRestored").GetBoolean()!=replayLateSource);seenFinal=true;
                if(hangingCommand=="acquire")input.Send(Command("3","close"));
                if(activeFailure)input.Send(Command("5","close"));
            }
        }
        Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==(replayLateSource?4:0));
        Require(child.TimedOut&&child.CloseRequests==(hangingCommand=="close"?1:0)&&child.StopRequests==1&&child.RecoveryLaunches==(recoveryRequired?1:0)&&proofCount==(replayLateSource?0:(recoveryRequired?1:0)+(lateSourceReply?0:1)));
    }
    private static void Require(bool value){if(!value)throw new Exception("Parent receipt assertion failed");}
    private static string Command(string id,string command,string session="",int generation=0)=>JsonSerializer.Serialize(new{id,command,payload=new{session,generation}});
    private static async Task<(JsonElement[] Rows,int Code)> Execute(Child[] children,string[] input)
    {
        var queue=new Queue<Child>(children);using var reader=new StringReader(string.Join('\n',input)+"\n");using var writer=new StringWriter();
        var caps=new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true);
        await using var runtime=new ProductPublicRuntime(caps,reader,writer,(_,_)=>Task.FromResult<IProductSupervisorProcess>(queue.Dequeue()));
        var result=await runtime.Run();
        var rows=writer.ToString().Split('\n',StringSplitOptions.RemoveEmptyEntries).Select(x=>JsonSerializer.Deserialize<JsonElement>(x)).ToArray();
        return(rows,result);
    }
    private sealed class Child(string session,int generation):IProductSupervisorProcess
    {
        public bool AcquireThrows,NoWrites,NeedsRecovery,RecoveryFails,Disposed,TimedOut,MissingDefaults,RetryFirstRelease;
        public string? HangCommand,AcquireCode;
        public Func<Task>? OnStop,OnRecovery;
        public int CloseRequests,StopRequests,ReleaseRequests;
        public string?[] Originals=[null,null];
        private bool recovered;
        public int RecoveryLaunches;
        public string LeaseId {get;}=Guid.NewGuid().ToString("D");
        public object? RetainedLeaseReceipt=>NoWrites?null:Lease("restored");
        public ProductDefaultStatus? TerminalDefaults=>NoWrites||MissingDefaults?null:new(true,["physical","physical","physical",null,null,null],["physical","physical","physical",null,null,null]);
        private object Lease(string state)=>new {leaseId=LeaseId,session,generation,state,ready=false,
            process=ProcessWire.From(new(9,new DateTime(2026,10,9,0,0,0,DateTimeKind.Utc).Ticks,"sid","policy","image","desktop")),
            originalRoles=new OriginalRole[]{new(0,Originals[0]),new(1,Originals[1])},captureDeviceId="capture",renderDeviceId="render"};
        public async Task<ServiceReply> Request(string body,CancellationToken token)
        {
            using var doc=JsonDocument.Parse(body);var command=doc.RootElement.GetProperty("command").GetString();var id=doc.RootElement.GetProperty("id").GetString();
            if(command=="close")CloseRequests++;
            if(command==HangCommand)
            {
                try{await Task.Delay(Timeout.InfiniteTimeSpan,token);}
                catch(OperationCanceledException){TimedOut=true;throw;}
            }
            if(command=="acquire"&&AcquireThrows)throw new IOException("SIMULATED_REPLY_LOSS");
            if(command=="acquire"&&AcquireCode is not null)return new ServiceReply(id,false,"blocked",AcquireCode);
            if(command=="release"&&++ReleaseRequests==1&&RetryFirstRelease)
                return new ServiceReply(id,false,"recoveryRequired","SOURCE_NOT_PAUSED",Lease:Lease("recoveryRequired"),CleanupRetryable:true,RestoreWritesStarted:false);
            return command switch
            {
                "acquire"=>new ServiceReply(id,true,"heldPaused","ACQUIRED",Lease:Lease("heldPaused")),
                "release"=>new ServiceReply(id,true,"restored","RELEASED",Lease:Lease("restored"),ExactOriginalRolesRestored:true,Defaults:TerminalDefaults,ObservedDefaultsChanged:false),
                "close"=>new ServiceReply(id,!NeedsRecovery,"closed",NoWrites?"NO_POLICY_WRITES":"RESTORED",NoPolicyWrites:NoWrites),
                _=>new ServiceReply(id,true,"inspected","INSPECTED")
            };
        }
        public async Task<ProductChildOutcome> Stop()
        {
            StopRequests++;if(OnStop is not null)await OnStop();
            return new ProductChildOutcome(true,false,!NoWrites&&(!NeedsRecovery||recovered),NeedsRecovery&&!recovered,NeedsRecovery&&!recovered?4:0,NoWrites);
        }
        public async Task<ProductChildOutcome> RecoverOnce()
        {
            if(RecoveryLaunches!=0)throw new IOException("ONLY_ONE_RECOVERY");RecoveryLaunches++;
            if(RecoveryFails)throw new IOException("UNRESOLVED_RECOVERY");
            if(OnRecovery is not null)await OnRecovery();recovered=true;
            return new ProductChildOutcome(true,false,true,false,0);
        }
        public ValueTask DisposeAsync(){Disposed=true;return ValueTask.CompletedTask;}
    }
    private sealed class PublicFeed:TextReader
    {
        private readonly Channel<char> data=Channel.CreateUnbounded<char>();
        public void Send(string line){foreach(var value in line+"\n")Require(data.Writer.TryWrite(value));}
        public override async ValueTask<int> ReadAsync(Memory<char> buffer,CancellationToken cancellationToken=default)
        {if(!await data.Reader.WaitToReadAsync(cancellationToken))return 0;if(!data.Reader.TryRead(out var value))return 0;buffer.Span[0]=value;return 1;}
        protected override void Dispose(bool disposing){data.Writer.TryComplete();base.Dispose(disposing);}
    }
    private sealed class PublicCapture:TextWriter
    {
        private readonly Channel<string> rows=Channel.CreateUnbounded<string>();
        public override Encoding Encoding=>Encoding.UTF8;
        public override void WriteLine(string? value){if(value is not null)rows.Writer.TryWrite(value);}
        public async Task<JsonElement> Read()=>JsonSerializer.Deserialize<JsonElement>(await rows.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
    }
}
