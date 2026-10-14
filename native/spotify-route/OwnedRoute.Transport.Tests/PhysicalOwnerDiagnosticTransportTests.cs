using System.Text.Json;
using System.Text.Json.Nodes;
using Folia.ProductRoute;
using Folia.RouteResearch;
using Folia.RouteRunner;

internal static class PhysicalOwnerDiagnosticTransportTests
{
    internal static async Task<int> Run()
    {
        var count=0;
        async Task Test(string name,Func<Task> body){await body();count++;Console.WriteLine("PASS "+name);}
        var valid=new PhysicalOwnerDiagnostic("owner-hardware-ids","wrong-type",1,"explicit",3,13,-2147467259,"hardware-ids",1,128,"usb");
        foreach(var command in new[]{"inspect","acquire"})
        foreach(var cause in new[]{"ORIGINAL_PHYSICAL_OWNER_UNPROVEN","ORIGINAL_EXPLICIT_ENDPOINT_CHANGED"})
            await Test(command+" physical-owner diagnostic survives private JSON and public stdout: "+cause,async()=>
            {
                var reply=new ServiceReply("test",false,"blocked",cause,PhysicalOwnerDiagnostic:valid);
                var (row,exit)=await Execute(command,reply);
                Require(exit==0&&!row.GetProperty("ok").GetBoolean());
                Require(row.GetProperty(command=="inspect"?"code":"failureCode").GetString()==cause);
                Require(row.GetProperty("code").GetString()==(command=="inspect"?cause:"NO_POLICY_WRITES"));
                var diagnostic=row.GetProperty("physicalOwnerDiagnostic");
                Require(JsonSerializer.Deserialize<PhysicalOwnerDiagnostic>(diagnostic,WireJson.Options)==valid);
                Require(diagnostic.EnumerateObject().Select(p=>p.Name).Order(StringComparer.Ordinal).SequenceEqual(
                    new[]{"stage","reason","role","originalKind","depth","nativeResult","hresult","property","propertyType","propertyLength","bus"}.Order(StringComparer.Ordinal)));
                Require(!row.GetRawText().Contains("private-",StringComparison.Ordinal));
            });
        foreach(var outcome in new[]{"restored","unresolved"})
            await Test("acquire "+outcome+" cleanup preserves bounded physical-owner cause",async()=>
            {
                var reply=new ServiceReply("test",false,"blocked","ORIGINAL_EXPLICIT_ENDPOINT_CHANGED",PhysicalOwnerDiagnostic:valid);
                var (row,exit)=await Execute("acquire",reply,outcome);
                Require(exit==(outcome=="restored"?0:4));
                Require(row.GetProperty("failureCode").GetString()==reply.Code);
                Require(row.GetProperty("code").GetString()==(outcome=="restored"?"ACQUIRE_FAILED_RESTORED":"PRODUCT_RESTORE_UNCONFIRMED"));
                Require(JsonSerializer.Deserialize<PhysicalOwnerDiagnostic>(row.GetProperty("physicalOwnerDiagnostic"),WireJson.Options)==valid);
            });
        await Test("public output independently rejects malformed or unrelated worker diagnostics",async()=>
        {
            var invalids=new[]{valid with{Stage="private-device-path"},valid with{Reason="private-exception-message"},
                valid with{OriginalKind="private-policy"},valid with{Property="private-property"},valid with{Bus="private-pnp-id"},
                valid with{Role=2},valid with{Depth=4},valid with{PropertyLength=4097}};
            foreach(var command in new[]{"inspect","acquire"})
            foreach(var invalid in invalids)
            {
                var (row,_)=await Execute(command,new("test",false,"blocked","ORIGINAL_PHYSICAL_OWNER_UNPROVEN",PhysicalOwnerDiagnostic:invalid));
                Require(!row.TryGetProperty("physicalOwnerDiagnostic",out _)&&!row.GetRawText().Contains("private-",StringComparison.Ordinal));
            }
            foreach(var reply in new[]{new ServiceReply("test",false,"blocked","SOURCE_NOT_PAUSED",PhysicalOwnerDiagnostic:valid),
                new ServiceReply("test",true,"inspected","INSPECTED",PhysicalOwnerDiagnostic:valid)})
            {
                var (row,_)=await Execute("inspect",reply);
                Require(!row.TryGetProperty("physicalOwnerDiagnostic",out _));
            }
        });
        await Test("public diagnostic omits absent fields and never carries unknown worker fields",async()=>
        {
            var minimal=new PhysicalOwnerDiagnostic("owner-locate","api-failed");
            var (row,_)=await Execute("inspect",new("test",false,"blocked","ORIGINAL_PHYSICAL_OWNER_UNPROVEN",PhysicalOwnerDiagnostic:minimal));
            Require(row.GetProperty("physicalOwnerDiagnostic").EnumerateObject().Select(p=>p.Name).SequenceEqual(new[]{"stage","reason"}));
            Require(!row.GetRawText().Contains("private-",StringComparison.Ordinal));
        });
        return count;
    }
    private static void Require(bool value){if(!value)throw new Exception("Physical-owner transport diagnostic assertion failed");}
    private static async Task<(JsonElement Row,int Exit)> Execute(string command,ServiceReply reply,string outcome="no-writes")
    {
        using var reader=new StringReader(JsonSerializer.Serialize(new{id="test",command,payload=new{}})+"\n"+
            JsonSerializer.Serialize(new{id="close",command="close",payload=new{}})+"\n");
        using var writer=new StringWriter();
        var child=new Child(reply,outcome);var caps=new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true);
        await using var runtime=new ProductPublicRuntime(caps,reader,writer,(_,_)=>Task.FromResult<IProductSupervisorProcess>(child));
        var exit=await runtime.Run();
        var rows=writer.ToString().Split('\n',StringSplitOptions.RemoveEmptyEntries).Select(value=>JsonSerializer.Deserialize<JsonElement>(value)).ToArray();
        return(rows.Single(row=>row.GetProperty("id").GetString()=="test"),exit);
    }
    private sealed class Child(ServiceReply reply,string outcome):IProductSupervisorProcess
    {
        public object? RetainedLeaseReceipt=>null;
        public ProductDefaultStatus? TerminalDefaults=>outcome=="restored"?new(true,["physical","physical","physical",null,null,null],["physical","physical","physical",null,null,null]):null;
        public Task<ServiceReply> Request(string body,CancellationToken cancellationToken)
        {
            using var request=JsonDocument.Parse(body);
            if(request.RootElement.GetProperty("command").GetString()=="close")return Task.FromResult(new ServiceReply("close",true,"closed","NO_POLICY_WRITES",NoPolicyWrites:true));
            // Model the private worker's JSON boundary, including unexpected
            // future/private fields. Typed deserialization cannot retain them.
            var wire=JsonSerializer.SerializeToNode(reply,WireJson.Options)!.AsObject();
            if(wire["physicalOwnerDiagnostic"] is JsonObject diagnostic)
            {
                diagnostic["pnpId"]="private-pnp-id";diagnostic["rawPolicy"]="private-raw-policy";
                diagnostic["path"]="private-device-path";diagnostic["fingerprint"]="private-fingerprint";
                diagnostic["exception"]="private-exception-message";diagnostic["serial"]="private-serial-number";
            }
            return Task.FromResult(wire.Deserialize<ServiceReply>(WireJson.Options)!);
        }
        public Task<ProductChildOutcome> Stop()=>Task.FromResult(new ProductChildOutcome(true,false,outcome=="restored",outcome=="unresolved",outcome=="unresolved"?4:0,outcome=="no-writes"));
        public Task<ProductChildOutcome> RecoverOnce()=>Task.FromResult(new ProductChildOutcome(true,false,false,true,4));
        public ValueTask DisposeAsync()=>ValueTask.CompletedTask;
    }
}
