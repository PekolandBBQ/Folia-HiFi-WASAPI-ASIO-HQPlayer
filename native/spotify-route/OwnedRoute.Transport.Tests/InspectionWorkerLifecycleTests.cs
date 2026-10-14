using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Folia.ProductRoute;
using Folia.RouteRunner;

// Exercises the public runtime with device-free supervisor doubles. No native
// discovery, process spawn, policy access or source-control request is executed.
internal static class InspectionWorkerLifecycleTests
{
    internal static async Task<int> Run()
    {
        var count=0;
        async Task Test(string name,Func<Task> body){await body();count++;Console.WriteLine("PASS "+name);}
        await Test("failed inspect reports promptly and immediate requests get busy during the single cleanup task",async()=>
        {
            using var input=new Feed();using var output=new Capture();
            var stopEntered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var permitStop=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var first=new Child{InspectFailure=true,OnStop=async()=>{stopEntered.SetResult();await permitStop.Task;}};
            var second=new Child();var workers=new Queue<Child>([first,second]);var starts=0;
            await using var runtime=Runtime(input,output,()=>{starts++;return workers.Dequeue();});
            var run=runtime.Run();input.Send(Command("1","inspect"));
            var failed=await output.Read();
            Require(!failed.GetProperty("ok").GetBoolean()&&failed.GetProperty("code").GetString()=="PRODUCT_OPERATION_FAILED","Failure must be delivered before cleanup completes");
            Require(!failed.TryGetProperty("lease",out _),"An unacquired worker must not inherit old lease evidence");
            var diagnostic=failed.GetProperty("operationFailureDiagnostic");
            Require(diagnostic.GetProperty("stage").GetString()=="inspect-request"&&diagnostic.GetProperty("cause").GetString()=="worker-unavailable","Inspect origin was erased");
            Require(!failed.GetRawText().Contains("private",StringComparison.Ordinal),"Inspect exception detail leaked");
            await stopEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            foreach(var command in new[]{"inspect","acquire","status"})
            {
                input.Send(Command("busy-"+command,command));var busy=await output.Read();
                Require(!busy.GetProperty("ok").GetBoolean()&&busy.GetProperty("code").GetString()=="ROUTE_BUSY","Immediate operations must fail promptly as busy");
                Require(starts==1&&!first.Disposed&&first.InspectRequests==1&&first.StopRequests==1,"Busy may not reuse, replace or stop the worker again");
            }
            input.Send(Command("passive","hello"));var hello=await output.Read();
            Require(hello.GetProperty("ok").GetBoolean(),"Passive capabilities should remain available");
            input.Send(Command("close","close"));
            Require(!run.IsCompleted,"Close must wait for the same cleanup task");
            permitStop.SetResult();
            Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0&&starts==1&&first.Disposed&&first.StopRequests==1&&first.RecoveryRequests==0,"Close must share cleanup without starting another worker or stop");
        });
        await Test("restored first lease cannot attach its receipt to a later failed inspect",async()=>
        {
            var first=new Child();var broken=new Child{InspectFailure=true};var third=new Child();
            var (rows,code)=await Execute([first,broken,third],[Command("1","inspect"),Command("2","acquire"),Command("3","release"),Command("4","inspect"),Command("5","inspect"),Command("6","close")]);
            Require(rows[2].GetProperty("exactOriginalRolesRestored").GetBoolean(),"Original release evidence changed");
            Require(!rows[3].TryGetProperty("lease",out _)&&!rows[3].GetProperty("ok").GetBoolean(),"Stale terminal receipt leaked into failed fresh inspect");
            Require(rows[4].GetProperty("ok").GetBoolean()&&first.Disposed&&broken.Disposed&&code==0,"Fresh inspection must work after clean retirement");
        });
        await Test("an inspect error after acquire never uses the no-write retirement path",async()=>
        {
            using var input=new Feed();using var output=new Capture();var child=new Child();
            await using var runtime=Runtime(input,output,()=>child);var run=runtime.Run();
            input.Send(Command("1","inspect"));await output.Read();input.Send(Command("2","acquire"));await output.Read();
            child.InspectFailure=true;input.Send(Command("3","inspect"));var failed=await output.Read();
            Require(!failed.GetProperty("ok").GetBoolean()&&failed.TryGetProperty("lease",out _),"Acquired owner receipt must be retained");
            Require(child.StopRequests==0&&!child.Disposed&&child.RecoveryRequests==0,"Inspect may not release or replace an acquired owner");
            input.Send(Command("4","release"));var release=await output.Read();
            Require(release.GetProperty("exactOriginalRolesRestored").GetBoolean()&&child.Disposed,"Scoped release must still own restoration");
            input.Send(Command("5","close"));Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0,"Close after restore failed");
        });
        foreach(var uncertain in new[]{"exit","prepared","receipt","recovery","terminal","stop-throws","dispose-throws"})
            await Test("failed inspect retains owner when retirement proof is uncertain: "+uncertain,async()=>
            {
                using var input=new Feed();using var output=new Capture();var child=new Child{InspectFailure=true,Uncertain=uncertain};var starts=0;
                await using var runtime=Runtime(input,output,()=>{starts++;return child;});var run=runtime.Run();
                input.Send(Command("1","inspect"));await output.Read();
                input.Send(Command("2","inspect"));var next=await output.Read();
                Require(!next.GetProperty("ok").GetBoolean()&&next.GetProperty("code").GetString()=="ROUTE_BUSY","Failed cleanup must stay blocked for later operations");
                Require(starts==1&&child.InspectRequests==1&&child.StopRequests==1&&child.RecoveryRequests==0,"Unconfirmed worker may not be reused, forgotten, stopped again or recovered by inspect cleanup");
                child.Uncertain=null;input.Send(Command("3","close"));
                Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0,"Final close must remain available");
            });
        foreach(var ending in new[]{"close","eof","dispose"})
            await Test("shutdown waits for the one pending inspect cleanup: "+ending,async()=>
            {
                using var input=new Feed();using var output=new Capture();
                var stopEntered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var permitStop=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var child=new Child{InspectFailure=true,OnStop=async()=>{stopEntered.SetResult();await permitStop.Task;}};
                var starts=0;var runtime=Runtime(input,output,()=>{starts++;return child;});
                var run=runtime.Run();input.Send(Command("1","inspect"));await output.Read();
                await stopEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
                Task? disposing=null;
                if(ending=="close")input.Send(Command("2","close"));
                else if(ending=="eof")input.End();
                else disposing=runtime.DisposeAsync().AsTask();
                Require(!run.IsCompleted&&(disposing is null||!disposing.IsCompleted)&&child.StopRequests==1&&!child.Disposed,"Shutdown must await cleanup rather than duplicating it");
                permitStop.SetResult();
                if(disposing is not null)
                {
                    await disposing.WaitAsync(TimeSpan.FromSeconds(2));
                    try{await run.WaitAsync(TimeSpan.FromSeconds(2));}catch(OperationCanceledException){}
                }
                else
                {
                    Require(await run.WaitAsync(TimeSpan.FromSeconds(2))==0,"Close or EOF must remain clean");
                    await runtime.DisposeAsync();
                }
                Require(starts==1&&child.StopRequests==1&&child.Disposed&&child.RecoveryRequests==0,"Shutdown must not create another worker, stop, or recovery");
            });
        await Test("ordinary rejected inspect preserves the usable worker",async()=>
        {
            var child=new Child{RejectFirstInspection=true};
            var (rows,code)=await Execute([child],[Command("1","inspect"),Command("2","inspect"),Command("3","close")]);
            Require(!rows[0].GetProperty("ok").GetBoolean()&&rows[0].GetProperty("code").GetString()=="EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN","Normal inspect rejection changed");
            Require(rows[1].GetProperty("ok").GetBoolean()&&child.InspectRequests==2&&child.StopRequests==1&&code==0,"Ordinary rejected inspect should not retire the healthy transport");
        });
        await Test("public reply rejects forged operation diagnostic enums and drops diagnostics on success",async()=>
        {
            var invalid=new Child{RejectFirstInspection=true,Diagnostic=new("private-path","worker-eof")};
            var (invalidRows,invalidCode)=await Execute([invalid],[Command("1","inspect"),Command("2","close")]);
            Require(!invalidRows[0].TryGetProperty("operationFailureDiagnostic",out _)&&invalidCode==0,"Unknown worker diagnostic crossed public boundary");
            var success=new Child{Diagnostic=new("inspect-request","worker-eof")};
            var (successRows,successCode)=await Execute([success],[Command("1","inspect"),Command("2","close")]);
            Require(successRows[0].GetProperty("ok").GetBoolean()&&!successRows[0].TryGetProperty("operationFailureDiagnostic",out _)&&successCode==0,"Success should not assert a failure diagnostic");
        });
        return count;
    }
    private static ProductPublicRuntime Runtime(TextReader input,TextWriter output,Func<Child> create)=>
        new(new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true),input,output,(_,_)=>Task.FromResult<IProductSupervisorProcess>(create()));
    private static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
    private static string Command(string id,string command)=>JsonSerializer.Serialize(new{id,command,payload=new{}});
    private static async Task<(JsonElement[] Rows,int Code)> Execute(Child[] children,string[] commands)
    {
        var queue=new Queue<Child>(children);using var input=new StringReader(string.Join('\n',commands)+"\n");using var output=new StringWriter();
        await using var runtime=Runtime(input,output,()=>queue.Dequeue());var code=await runtime.Run();
        return(output.ToString().Split('\n',StringSplitOptions.RemoveEmptyEntries).Select(row=>JsonSerializer.Deserialize<JsonElement>(row)).ToArray(),code);
    }
    private sealed class Child:IProductSupervisorProcess
    {
        public bool InspectFailure,RejectFirstInspection,Disposed;
        public string? Uncertain;
        public OperationFailureDiagnostic? Diagnostic;
        public int InspectRequests,StopRequests,RecoveryRequests;
        public Func<Task>? OnStop;
        private bool acquired;
        public object? RetainedLeaseReceipt=>acquired||Uncertain=="receipt"?new{leaseId="test-lease",session="test-session",generation=1,state="heldPaused",ready=false}:null;
        public ProductDefaultStatus? TerminalDefaults=>acquired?new(true,["physical","physical","physical",null,null,null],["physical","physical","physical",null,null,null]):null;
        public Task<ServiceReply> Request(string body,CancellationToken token)
        {
            using var doc=JsonDocument.Parse(body);var command=doc.RootElement.GetProperty("command").GetString();var id=doc.RootElement.GetProperty("id").GetString();
            if(command=="inspect")
            {
                InspectRequests++;
                if(InspectFailure)throw new IOException("PRODUCT_WORKER_UNAVAILABLE:private-path-must-not-leak");
                if(RejectFirstInspection&&InspectRequests==1)return Task.FromResult(new ServiceReply(id,false,"blocked","EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN",OperationFailureDiagnostic:Diagnostic));
                return Task.FromResult(new ServiceReply(id,true,"inspected","INSPECTED",OperationFailureDiagnostic:Diagnostic));
            }
            if(command=="acquire"){acquired=true;return Task.FromResult(new ServiceReply(id,true,"heldPaused","ACQUIRED",Lease:RetainedLeaseReceipt));}
            if(command=="release")return Task.FromResult(new ServiceReply(id,true,"restored","RELEASED",Lease:RetainedLeaseReceipt,ExactOriginalRolesRestored:true,Defaults:TerminalDefaults,ObservedDefaultsChanged:false));
            return Task.FromResult(new ServiceReply(id,true,"closed",acquired?"RESTORED":"NO_POLICY_WRITES",NoPolicyWrites:!acquired));
        }
        public async Task<ProductChildOutcome> Stop()
        {
            StopRequests++;if(OnStop is not null)await OnStop();
            if(Uncertain=="stop-throws")throw new IOException("STOP_UNCONFIRMED");
            return new(Uncertain!="exit",false,acquired||Uncertain=="terminal",Uncertain=="recovery",0,!acquired&&Uncertain!="prepared");
        }
        public Task<ProductChildOutcome> RecoverOnce(){RecoveryRequests++;throw new InvalidOperationException("Inspect must not launch recovery");}
        public ValueTask DisposeAsync()
        {
            if(Uncertain=="dispose-throws")throw new IOException("DISPOSE_UNCONFIRMED");
            Disposed=true;return ValueTask.CompletedTask;
        }
    }
    private sealed class Feed:TextReader
    {
        private readonly Channel<char> data=Channel.CreateUnbounded<char>();
        public void Send(string line){foreach(var value in line+"\n")Require(data.Writer.TryWrite(value),"Input closed");}
        public void End()=>data.Writer.TryComplete();
        public override async ValueTask<int> ReadAsync(Memory<char> buffer,CancellationToken token=default)
        {if(!await data.Reader.WaitToReadAsync(token))return 0;if(!data.Reader.TryRead(out var value))return 0;buffer.Span[0]=value;return 1;}
        protected override void Dispose(bool disposing){data.Writer.TryComplete();base.Dispose(disposing);}
    }
    private sealed class Capture:TextWriter
    {
        private readonly Channel<string> rows=Channel.CreateUnbounded<string>();
        public override Encoding Encoding=>Encoding.UTF8;
        public override void WriteLine(string? value){if(value is not null)rows.Writer.TryWrite(value);}
        public async Task<JsonElement> Read()=>JsonSerializer.Deserialize<JsonElement>(await rows.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5)));
    }
}
