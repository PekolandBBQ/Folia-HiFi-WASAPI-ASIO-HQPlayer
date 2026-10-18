using System.Text.Json;
using System.Text.Json.Serialization;
using Folia.ProductRoute;
using Folia.RouteResearch;

internal static class PhysicalOwnerDiagnosticTests
{
    internal static int Run()
    {
        var count=0;
        void Test(string name,Action body){body();count++;Console.WriteLine("PASS "+name);}
        var endpoint=new PhysicalOwnerDiagnostic("endpoint-policy","target-is-original",Role:0,OriginalKind:"explicit",EndpointState:1,EndpointFlow:0,TargetMatch:true,PolicyMatch:true);
        if(PhysicalOwnerDiagnosticProjection.FromFailure("ORIGINAL_ENDPOINT_UNSAFE",endpoint)!=endpoint)throw new Exception("Endpoint diagnostic lost at projection");
        var valid=new PhysicalOwnerDiagnostic("owner-hardware-ids","wrong-type",1,"explicit",3,13,-2147467259,"hardware-ids",1,128,"usb");
        foreach(var command in new[]{"inspect","acquire"})
        foreach(var code in new[]{"ORIGINAL_PHYSICAL_OWNER_UNPROVEN","ORIGINAL_EXPLICIT_ENDPOINT_CHANGED"})
            Test(command+" preserves bounded physical-owner failure without opening a lifetime: "+code,()=>
            {
                var error=new RouteBlockedException(code,valid);
                error.Data["rawPolicy"]="private-policy-value";
                error.Data["pnpId"]="private-serial-value";
                var backend=new Backend(error);using var service=new ProductRouteService(backend);
                var reply=service.Dispatch(Command(command));
                Require(!reply.Ok&&reply.Code==code&&reply.PhysicalOwnerDiagnostic==valid&&backend.Opens==0&&!service.HasLease);
                var json=JsonSerializer.Serialize(reply,Options);
                Require(!json.Contains("private-",StringComparison.Ordinal));
                var restored=JsonSerializer.Deserialize<ServiceReply>(json,Options)!;
                Require(restored.PhysicalOwnerDiagnostic==valid&&restored.Code==code);
                // A subsequent unrelated reply must not retain prior evidence.
                Require(service.Dispatch(Command("hello")).PhysicalOwnerDiagnostic is null);
            });
        Test("physical-owner projection rejects arbitrary strings and out-of-contract bounds",()=>
        {
            foreach(var invalid in new[]{valid with{Stage="private-pnp-id"},valid with{Reason="private-exception-text"},
                valid with{OriginalKind="private-policy-value"},valid with{Property="private-property-value"},
                valid with{Bus="private-serial-value"},valid with{Role=-1},valid with{Role=2},
                valid with{Depth=-1},valid with{Depth=4},valid with{PropertyLength=4097}})
            {
                using var service=new ProductRouteService(new Backend(new("ORIGINAL_PHYSICAL_OWNER_UNPROVEN",invalid)));
                var reply=service.Dispatch(Command("inspect"));
                Require(!reply.Ok&&reply.Code=="ORIGINAL_PHYSICAL_OWNER_UNPROVEN"&&reply.PhysicalOwnerDiagnostic is null);
                Require(!JsonSerializer.Serialize(reply,Options).Contains("private-",StringComparison.Ordinal));
            }
        });
        Test("unrelated failures cannot publish physical-owner evidence",()=>
        {
            using var service=new ProductRouteService(new Backend(new("SOURCE_NOT_PAUSED",valid)));
            var reply=service.Dispatch(Command("inspect"));
            Require(!reply.Ok&&reply.Code=="SOURCE_NOT_PAUSED"&&reply.PhysicalOwnerDiagnostic is null);
        });
        Test("nullable diagnostic fields remain omitted and numeric bounds are preserved",()=>
        {
            var minimal=new PhysicalOwnerDiagnostic("owner-locate","api-failed");
            var projected=PhysicalOwnerDiagnosticProjection.FromFailure("ORIGINAL_PHYSICAL_OWNER_UNPROVEN",minimal)!;
            var json=JsonSerializer.SerializeToElement(projected,Options);
            Require(json.EnumerateObject().Select(p=>p.Name).SequenceEqual(new[]{"stage","reason"}));
            var boundary=valid with{Role=0,OriginalKind="default",Depth=0,NativeResult=uint.MaxValue,Hresult=int.MinValue,PropertyType=uint.MaxValue,PropertyLength=4096,Bus="unknown"};
            Require(PhysicalOwnerDiagnosticProjection.FromFailure("ORIGINAL_PHYSICAL_OWNER_UNPROVEN",boundary)==boundary);
        });
        return count;
    }
    private static readonly JsonSerializerOptions Options=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,DefaultIgnoreCondition=JsonIgnoreCondition.WhenWritingNull};
    private static string Command(string command)=>JsonSerializer.Serialize(new{id="diagnostic",command,payload=new
    {session="diagnostic-session",generation=1,sourcePaused=true,captureDeviceId="capture",renderDeviceId="render"}});
    private static void Require(bool value){if(!value)throw new Exception("Physical-owner service diagnostic assertion failed");}
    private sealed class Backend(RouteBlockedException error):IProductRouteBackend
    {
        public int Opens;
        public ProductCapabilities Capabilities {get;}=new(true,true,true,true,true,[],IntervalIsolation:true);
        public ProductDiscovery Inspect(RouteSelection selection)=>throw error;
        public IProductRouteLifetime Open(ProductDiscovery discovery){Opens++;throw new Exception("Unexpected lifetime open");}
    }
}
