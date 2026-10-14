using System.Text.Json;
using System.Text.Json.Nodes;
using Folia.ProductRoute;
using Folia.RouteResearch;

// Explicit test-only Linux adapter. No native Windows/backend or policy setter
// assembly is referenced. Service, ledger, pause verifier and transaction are real.
// Mock policy/inspection/native-session state is injected as _fixture in each
// request; actual source observations travel through the normal source broker.
internal static class StdioBridge
{
    private static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase};
    internal static void Run()
    {
        var fixture=new Fixture {RealTime=true};
        fixture.Broker=target=>ReadSource(fixture,target);
        try
        {
            for(string? line;(line=Console.ReadLine()) is not null;)
            {
                using var input=JsonDocument.Parse(line);
                if(input.RootElement.TryGetProperty("_fixture",out var state))
                {
                    if(state.TryGetProperty("sourcePlaying",out var playing))fixture.Paused=!playing.GetBoolean();
                    if(state.TryGetProperty("sourceTrackUri",out var uri))fixture.TrackUri=uri.GetString()!;
                    if(state.TryGetProperty("pcmStopped",out var stopped))fixture.PcmStopped=stopped.GetBoolean();
                    if(state.TryGetProperty("failRestore",out var restore))fixture.FailRestore=restore.GetBoolean();
                    if(state.TryGetProperty("failColdInspectionOnce",out var cold))fixture.FailColdInspectionOnce=cold.GetBoolean();
                }
                var response=fixture.Service.Dispatch(line);
                var json=JsonSerializer.SerializeToNode(response,Json)!.AsObject();
                json["_fixtureMetrics"]=JsonSerializer.SerializeToNode(new{fixture.SourceReads,fixture.SessionScans,fixture.PolicyScans,fixture.Writes,fixture.Suspended},Json);
                Console.WriteLine(json.ToJsonString(Json));Console.Out.Flush();
                if(fixture.Service.Closed)break;
            }
        }
        finally { fixture.Service.Dispose(); }
    }
    private static PlaybackStatus ReadSource(Fixture fixture,OwnedPlaybackTarget target)
    {
        var id="source-"+Guid.NewGuid().ToString("D");
        var request=new { @event="sourceControl", requestId=id, action="read", session=fixture.BoundSession,
            generation=fixture.BoundGeneration, sourceDeviceId=target.DeviceId, expectedSourceUri=target.TrackUri,
            pausedPreviousUri=target.PausedPreviousTrackUri, allowPreviousPaused=target.AllowPreviousPaused,
            requirePreparedSelection=target.RequirePreparedSelection, preparationSelectedSourceUri=target.PreparationSelectedSourceUri,
            requirePreparationObservation=target.RequirePreparationObservation, preparationPhase=target.PreparationPhase,
            restoreOperationId=target.RestoreOperationId, allowChangedTrackPausedForRestore=target.AllowChangedTrackPausedForRestore };
        Console.WriteLine(JsonSerializer.Serialize(request,Json));Console.Out.Flush();
        var line=Console.ReadLine()??throw new RouteBlockedException("SOURCE_BROKER_UNAVAILABLE");
        using var document=JsonDocument.Parse(line);var root=document.RootElement;
        if(root.GetProperty("id").GetString()!=id||root.GetProperty("command").GetString()!="sourceControlResult")
            throw new RouteBlockedException("SOURCE_BROKER_FAILED");
        var result=root.GetProperty("payload");
        if(!result.GetProperty("ok").GetBoolean())throw new RouteBlockedException("SOURCE_BROKER_FAILED");
        string? Text(string name)=>result.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString():null;
        bool Flag(string name)=>result.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.True;
        bool? OptionalFlag(string name)=>result.TryGetProperty(name,out var value)&&value.ValueKind is JsonValueKind.True or JsonValueKind.False?value.GetBoolean():null;
        long? Integer(string name)=>result.TryGetProperty(name,out var value)&&value.TryGetInt64(out var number)?number:null;
        return new(Text("sourceDeviceId")??"",Text("trackUri"),Flag("isPlaying"),result.GetProperty("observedAtUtc").GetDateTimeOffset(),
            Flag("pcmStopped"),Flag("preparationOwned"),OptionalFlag("playbackRequestPending"),Integer("observationGeneration"),Integer("mutationEpoch"),
            Text("preparationPhase"),Integer("positionMs"),Text("restoreOperationId"));
    }
}
