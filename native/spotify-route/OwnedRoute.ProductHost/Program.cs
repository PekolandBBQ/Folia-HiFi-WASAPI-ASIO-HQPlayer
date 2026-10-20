using Folia.RouteRunner;
using System.Text;

// Electron sends UTF-8 JSON. Preserve opaque session IDs containing Unicode paths.
Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);

// Each host, worker and recovery process checks its local routing interfaces.
var admission=WindowsProductAdmission.Automatic;
if(args.Length==1&&args[0]=="--repair-spotify-output")
{
    try {Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(SpotifyOutputRepair.Run()));return 0;}
    catch(Exception error) {
        var code=error.Message;
        if(!System.Text.RegularExpressions.Regex.IsMatch(code,"^[A-Z][A-Z0-9_]{1,127}$"))code="SPOTIFY_OUTPUT_REPAIR_FAILED";
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new{repaired=false,code,globalDefaultsWritten=false}));return 3;
    }
}
if(args.Length==1&&args[0]=="--recover-orphan-route")
{
    try { Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(OrphanRouteRecovery.Run())); return 0; }
    catch(Exception error) {
        var code = error.Message;
        if (!System.Text.RegularExpressions.Regex.IsMatch(code, "^[A-Z][A-Z0-9_]{1,127}$")) code = "ORPHAN_ROUTE_RECOVERY_FAILED";
        Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new {restored=false,code})); return 3;
    }
}
if(args.Length==1&&args[0]=="--product-worker")
    return await ProductWorkerRuntime.Run(channel=>new WindowsProductBackend(channel,
        ((ProductWorkerChannel)channel).CreateSourceControl,admission));
if(args.Length==1&&args[0]=="--product-recover")
    return await ProductWorkerRuntime.Run(channel=>throw new InvalidOperationException("RECOVERY_ONLY"),recovery:true,
        recover:(channel,start)=>ProductRecoveryRuntime.Run(channel,start,admission));
if(args.Length!=0)return 2;
await using var host=new ProductPublicRuntime(admission.Capabilities);
return await host.Run();
