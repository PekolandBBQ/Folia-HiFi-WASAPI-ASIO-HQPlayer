using System.Diagnostics;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

// Feasibility A only: facts from partial snapshots, never a complete inventory.
internal sealed record FrozenOriginals(string?[] Values,string[] Endpoints)
{
    internal static FrozenOriginals Read(string?[] values,Func<int,string> defaultEndpoint,Func<string,string?> map)
    {
        if(values.Length!=3 || values.Any(x=>x=="")) throw new RouteBlockedException("ORIGINAL_VALUES_UNSUPPORTED");
        var endpoints=Enumerable.Range(0,2).Select(role=>values[role] is null?defaultEndpoint(role):
            map(values[role]!)??throw new RouteBlockedException("ORIGINAL_POLICY_ENDPOINT_MAPPING_UNPROVED")).ToArray();
        return new(values.ToArray(),endpoints);
    }
    internal void Check(string?[] present,Func<int,string> defaultEndpoint,Func<string,string?> map)
    {
        if(!Values.SequenceEqual(present)) throw new RouteBlockedException("FROZEN_ORIGINAL_POLICY_CHANGED");
        for(var role=0;role<2;role++)
        {
            var mapped=Values[role] is null?defaultEndpoint(role):map(Values[role]!);
            if(!string.Equals(mapped,Endpoints[role],StringComparison.OrdinalIgnoreCase))
                throw new RouteBlockedException("FROZEN_ORIGINAL_ENDPOINT_CHANGED");
        }
    }
}

internal sealed record PreparedSample(NativeSession[] Rows,SessionObservation Observation,long CompletedMs);
internal static class BoundedPrepare
{
    internal const int ExternalStartNotAfterMs=60_000,MaximumPrepareMs=65_000,MaximumScanMs=1_000,IntervalMs=100;
    internal const int MaximumActualUiPlayMs=30_000,OuterUiPauseMs=90_000;
    internal static object ReadyEvidence(DateTimeOffset readyAt,int pid,FrozenOriginals originals)=>new
    {
        firstReadyAtUtc=readyAt,prepareEndsUtc=readyAt.AddMilliseconds(MaximumPrepareMs),
        startNotAfterUtc=readyAt.AddMilliseconds(ExternalStartNotAfterMs),outerPauseDeadlineUtc=readyAt.AddMilliseconds(OuterUiPauseMs),
        maximumActualPlayToPauseMs=MaximumActualUiPlayMs,maximumReadonlyPrepareMs=MaximumPrepareMs,
        selectedVerifiedPid=pid,frozenOriginals=originals,policySetters=0,journalOpened=false,
        instruction="Start the already-authorized normal Spotify UI Play once by startNotAfterUtc (FIRST_READY+60s), at the prepared low volume. The final 5s is detection allowance only. Pause within 30 seconds of actual Play and no later than outerPauseDeadlineUtc. On tool failure or exit, pause immediately. Do not restart, extend playback, or wait for another READY. Late or insufficient preparation causes no route application. The tool never controls playback.",
        timingEnforcedByTool=false,operatorPlayAndPauseEvidenceRequired=true,completeForProcess=false,productionReady=false
    };
    internal static NativeSession[] BracketedSnapshot(SpotifyProcess process,Func<SpotifyProcess> check,Func<NativeSession[]> scan,
        Func<bool> cancelled,Func<long> elapsedMs,int deadlineMs)
    {
        var started=elapsedMs();
        if(cancelled() || started>=deadlineMs) throw new RouteBlockedException("PREPARE_DEADLINE_OR_CANCELLED");
        if(check()!=process) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        var rows=scan();
        if(check()!=process) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        var completed=elapsedMs();
        if(cancelled() || completed>=deadlineMs || completed-started>MaximumScanMs)
            throw new RouteBlockedException("PREPARE_LATE_SNAPSHOT_REJECTED");
        SessionIdentity.RequireUnambiguousForApply(rows);
        return rows;
    }
    internal static void RequireNoOtherSpotify(NativeSession[] rows,int selectedPid,int[] candidatePids)
    {
        if(rows.Any(x=>x.IsSystemSounds==false && x.HasSingleProcessIdentity && x.ReportedProcessId!=selectedPid &&
            x.State==1 && candidatePids.Contains((int)x.ReportedProcessId)))
            throw new RouteBlockedException("OTHER_SPOTIFY_AUDIO_PROCESS_ACTIVE");
    }
    internal static bool ActiveOriginalOnly(SpotifyProcess process,NativeSession[] rows,FrozenOriginals originals,string target)
    {
        SessionIdentity.RequireUnambiguousForApply(rows);
        var active=SnapshotFacts.ForProcess(process,rows).Sessions.Where(x=>x.Active).ToArray();
        if(active.Any(x=>string.Equals(x.EndpointId,target,StringComparison.OrdinalIgnoreCase) ||
            !originals.Endpoints.Contains(x.EndpointId,StringComparer.OrdinalIgnoreCase)))
            throw new RouteBlockedException("ACTIVE_SELECTED_SESSION_NOT_ON_FROZEN_ORIGINAL");
        return active.Length>0;
    }
    internal static void RequirePreparedPolicyValues(RouteRecord record,FrozenOriginals frozen,string?[] current)
    {
        if(!record.Roles.Select(x=>x.Original).SequenceEqual(frozen.Values))
            throw new RouteBlockedException("FROZEN_ORIGINAL_POLICY_CHANGED");
        var expected=record.Roles.Select(x=>x.Stage==RoleStage.Applied?record.Target.PolicyValue:x.Original);
        if(!expected.SequenceEqual(current)) throw new RouteBlockedException("PREAPPLY_ROLE_POLICY_CHANGED");
    }
    internal static void RequireTransitionEndpoints(SpotifyProcess process,NativeSession[] rows,FrozenOriginals frozen,string target)
    {
        SessionIdentity.RequireUnambiguousForApply(rows);
        var allowed=frozen.Endpoints.Append(target).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if(SnapshotFacts.ForProcess(process,rows).Sessions.Any(x=>x.Active && !allowed.Contains(x.EndpointId)))
            throw new RouteBlockedException("ACTIVE_SELECTED_SESSION_OUTSIDE_PREPARED_TRANSITION");
    }
    internal static PreparedSample Wait(SpotifyProcess process,FrozenOriginals originals,string target,Func<NativeSession[]> scan,
        Func<SpotifyProcess> check,Action checkOriginals,Func<int[]> candidatePids,Func<bool> cancelled,Func<long> elapsedMs,Action<int> delay)
    {
        while(!cancelled() && elapsedMs()<MaximumPrepareMs)
        {
            checkOriginals();
            var rows=BracketedSnapshot(process,check,scan,cancelled,elapsedMs,MaximumPrepareMs);
            var sampleAt=elapsedMs();
            RequireNoOtherSpotify(rows,process.Pid,candidatePids());
            checkOriginals();
            if(cancelled() || elapsedMs()>=MaximumPrepareMs) throw new RouteBlockedException("PREPARE_DEADLINE_OR_CANCELLED");
            if(elapsedMs()-sampleAt>MaximumScanMs) throw new RouteBlockedException("PREPARE_SAMPLE_BECAME_STALE");
            if(ActiveOriginalOnly(process,rows,originals,target))
                return new(rows,SnapshotFacts.ForProcess(process,rows),sampleAt);
            delay((int)Math.Min(IntervalMs,MaximumPrepareMs-elapsedMs()));
        }
        throw new RouteBlockedException("NO_FRESH_ACTIVE_ORIGINAL_WITHIN_PREPARE_WINDOW");
    }
}
