using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Folia.ProductRoute;

// Deliberately no Native/Windows project references or permissive launch modes.
// The installed composition cannot activate COM or write any route policy.
if(args.Length!=0) return 2;
using var service=new ProductRouteService(new UnqualifiedProductBackend());
var json=new JsonSerializerOptions { PropertyNamingPolicy=JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition=JsonIgnoreCondition.WhenWritingNull };
while(!service.Closed)
{
    string? line;
    using var timeout=new CancellationTokenSource();
    if(service.HasLease) timeout.CancelAfter(ProductRouteService.IdleLimit);
    try {line=await WireInput.ReadLine(Console.In,16*1024,timeout.Token);}
    catch(OperationCanceledException) {await Emit(service.Disconnect("OWNER_HEARTBEAT_EXPIRED"));return 4;}
    catch(Exception e) when(e is IOException or InvalidDataException)
    {await Emit(service.Disconnect("CONTROL_CHANNEL_FAILED:"+e.Message));return 4;}
    if(line is null)
    {
        var terminal=service.Disconnect("OWNER_CHANNEL_EOF");
        return await Emit(terminal) && terminal.Ok ? 0 : 4;
    }
    var reply=service.Dispatch(line);
    if(!await Emit(reply)) {service.Disconnect("OWNER_OUTPUT_LOST");return 4;}
    if(service.Closed && (!reply.Ok || reply.Code.StartsWith("CONTROL_PROTOCOL_INVALID:",StringComparison.Ordinal))) return 4;
}
return 0;

async Task<bool> Emit(ServiceReply reply)
{
    try {await Console.Out.WriteLineAsync(JsonSerializer.Serialize(reply,json));await Console.Out.FlushAsync();return true;}
    catch(Exception e) when(e is IOException or ObjectDisposedException) {return false;}
}
