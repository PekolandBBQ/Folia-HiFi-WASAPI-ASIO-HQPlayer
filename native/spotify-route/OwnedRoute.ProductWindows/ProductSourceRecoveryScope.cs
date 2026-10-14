using System.Text.Json;
using Folia.ProductRoute;

namespace Folia.RouteRunner;

// Reconstructed from the statically extracted dev11 OwnedRoute.ProductWindows
// assembly, Folia.RouteRunner.ProductSourceRecoveryScope. This is source-equivalent
// recovery code, not the original author's source or an original test artifact.
internal static class ProductSourceRecoveryScope
{
    internal static ProductRecoveryBaseline? Advance(string? command,JsonElement payload,
        ServiceReply response,ProductRecoveryBaseline? baseline)
    {
        if(!response.Ok)return baseline;
        if(command=="holdExternalSelection")
        {
            if(baseline is null || response.State!="pausedHeld" || response.Ready || response.ResumeAuthorized || response.IntervalArmed)
                throw new InvalidDataException("PREPARED_SELECTION_REPLY_INVALID");
            var selectedExternal=payload.GetProperty("selectedSourceUri").GetString();
            var nextEpoch=payload.GetProperty("sourceEpoch").GetInt32();
            if(!OwnedPlaybackTarget.IsSelectedSourceUri(selectedExternal)
                || payload.GetProperty("pausedSourceUri").GetString()!=baseline.Source.TrackUri
                || nextEpoch!=baseline.Source.SourceEpoch+1)throw new InvalidDataException("SOURCE_TRACK_CHANGED");
            return baseline with{Source=baseline.Source.ForFreshRecovery() with{TrackUri=selectedExternal,SourceEpoch=nextEpoch,
                PausedPreviousTrackUri=null,AllowPreviousPaused=false}};
        }
        var resumePreparation=command=="resumePreparation";
        var trackRebind=command=="rebindPreparedSelection";
        if(resumePreparation&&!response.PreparedSelectionAuthorized)
            throw new InvalidDataException("PREPARED_SELECTION_REPLY_INVALID");
        var prepare=(command=="authorizePreparedSelection"||resumePreparation||trackRebind)&&response.PreparedSelectionAuthorized;
        var resume=command=="authorizeResume"&&response.ResumeAuthorized;
        var complete=command=="completePreparedSelection"&&response.PreparedSelectionCompleted;
        if(!prepare&&!resume&&!complete)return baseline;
        if(baseline is null)throw new InvalidDataException("RECOVERY_BASELINE_REQUIRED");
        if(prepare&&(response.State!="preparedSelection"||response.Ready||response.ResumeAuthorized||response.IntervalArmed)||
           complete&&(response.State!="heldPaused"||response.Ready||response.ResumeAuthorized||response.IntervalArmed))
            throw new InvalidDataException("PREPARED_SELECTION_REPLY_INVALID");
        var source=baseline.Source;
        if(complete)return baseline with{Source=source with{PausedPreviousTrackUri=null,AllowPreviousPaused=false}};
        var selected=payload.GetProperty("selectedSourceUri").GetString();
        if(string.IsNullOrWhiteSpace(selected)||selected.Length>2048||prepare&&!OwnedPlaybackTarget.IsSelectedSourceUri(selected))
            throw new InvalidDataException("SOURCE_URI_INVALID");
        if(trackRebind&&(payload.GetProperty("pausedSourceUri").GetString()!=source.TrackUri
            || payload.GetProperty("sourceEpoch").GetInt32()!=source.SourceEpoch+1))throw new InvalidDataException("SOURCE_TRACK_CHANGED");
        if(resumePreparation&&selected!=source.TrackUri)throw new InvalidDataException("SOURCE_TRACK_CHANGED");
        var unchanged=selected==source.TrackUri;
        return baseline with{Source=source with{TrackUri=selected,SourceEpoch=trackRebind?payload.GetProperty("sourceEpoch").GetInt32():source.SourceEpoch,PausedPreviousTrackUri=unchanged?null:source.TrackUri,AllowPreviousPaused=!unchanged}};
    }
}
