using Folia.ProductRoute;
using Folia.RouteResearch;

internal static class KeeperRebindContractTests
{
    internal static void Run()
    {
        var now = Fixture.StartTime;
        var park = new OwnedSeekParkReceipt("seek-parked", "session", 1, Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"),
            5000, true, true, true, true, false, new("session", 1, 1, now.ToUnixTimeMilliseconds()));
        var keeper = new OwnedSilentRenderLeaseProof("session", 1, "render", "keeper", Guid.NewGuid(), 20, now.Ticks);
        var next = keeper with { CaptureGeneration = 2 };
        var source = new OwnedPlaybackTarget("device", Fixture.Track, Fixture.Identity, RequirePreparedSelection: true,
            PreparationSelectedSourceUri: Fixture.Track, RequirePreparationObservation: true, PreparationPhase: "selected",
            RequireSeekParkEvidence: true, SeekParkReceipt: park);
        var arm = source with { RequirePreparedSelection = false, PreparationSelectedSourceUri = null,
            RequireSeekParkEvidence = false, SeekParkReceipt = null };
        var paused = new PlaybackStatus("device", Fixture.Track, false, now, PreparationOwned: true, PlaybackRequestPending: false,
            ObservationGeneration: 6, MutationEpoch: 5, PreparationPhase: "selected", PositionMs: 17421, CaptureParkReceipt: park);
        var rebound = paused with { CaptureParkReceipt = null, PcmStopped = true };
        PreparationObservationLedger Ledger() { var ledger = new PreparationObservationLedger(); ledger.Validate(source, paused, now); return ledger; }
        void Block(Action action, string code) { try { action(); } catch (RouteBlockedException e) { if (e.Message == code) return; throw; } throw new Exception("Expected " + code); }
        int count = 0;
        void Test(string name, Action run) { run(); count++; Console.WriteLine("PASS keeper-rebind " + name); }
        Test("exact live keeper transition preserves every source field through both reads and authorize", () => {
            var ledger = Ledger();
            ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now);
            ledger.Validate(arm, rebound, now); ledger.Validate(arm, rebound, now);
            ledger.Validate(arm, rebound with { PcmStopped = false }, now.AddMilliseconds(400));
            Block(() => ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now), "SEEK_PARK_REBIND_OBSERVATION_INVALID");
        });
        Test("ordinary receipt equality still includes park evidence", () => {
            if (PreparationObservationLedger.SameReceipt(paused, rebound)) throw new Exception("Global equality weakened");
            Block(() => Ledger().Validate(arm, rebound, now), "PREPARATION_OBSERVATION_REPLAYED");
        });
        var sourceFaults = new Func<PlaybackStatus, PlaybackStatus>[] {
            p => p with { ObservationGeneration = 7 }, p => p with { MutationEpoch = 6 }, p => p with { ObservedAtUtc = now.AddMilliseconds(1) },
            p => p with { DeviceId = "other" }, p => p with { TrackUri = Fixture.Other }, p => p with { PositionMs = 17422 },
            p => p with { IsPlaying = true }, p => p with { PreparationPhase = "baseline" }, p => p with { CaptureParkReceipt = park },
            p => p with { RestoreOperationId = Guid.NewGuid().ToString("D") }
        };
        for (int i = 0; i < sourceFaults.Length; i++) { var fault = sourceFaults[i]; Test("changed source fact " + i + " burns one-use transition", () => {
            var ledger = Ledger(); ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now);
            Block(() => ledger.Validate(arm, fault(rebound), now), "SEEK_PARK_REBIND_OBSERVATION_INVALID");
            Block(() => ledger.Validate(arm, rebound, now), "PREPARATION_OBSERVATION_REPLAYED");
        }); }
        var keeperFaults = new Func<OwnedSilentRenderLeaseProof, OwnedSilentRenderLeaseProof>[] {
            p => p with { CaptureSession = "other" }, p => p with { CaptureGeneration = 1 }, p => p with { EndpointId = "other" },
            p => p with { SessionInstanceId = "other" }, p => p with { GroupingId = Guid.NewGuid() },
            p => p with { ProcessId = 21 }, p => p with { StartedAtUtcTicks = p.StartedAtUtcTicks + 1 }
        };
        for (int i = 0; i < keeperFaults.Length; i++) { var fault = keeperFaults[i]; Test("changed keeper binding " + i, () =>
            Block(() => Ledger().AuthorizeSeekKeeperRebind(park, keeper, fault(next), now), "SEEK_PARK_KEEPER_CHANGED")); }
        Test("changed Spotify process rejects unchanged receipt", () => {
            var ledger = Ledger(); ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now);
            Block(() => ledger.Validate(arm with { Process = Fixture.Identity with { Pid = 13 } }, rebound, now), "SEEK_PARK_REBIND_OBSERVATION_INVALID");
        });
        Test("wrong park transaction cannot retire adjunct", () =>
            Block(() => Ledger().AuthorizeSeekKeeperRebind(park with { SeekTransaction = Guid.NewGuid().ToString("D") }, keeper, next, now), "SEEK_PARK_REBIND_OBSERVATION_INVALID"));
        Test("original five-second park deadline applies at issuance", () =>
            Block(() => Ledger().AuthorizeSeekKeeperRebind(park, keeper, next, now.AddSeconds(5)), "SEEK_PARK_EXPIRED"));
        Test("original five-second park deadline applies at consume", () => {
            var ledger = Ledger(); ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now.AddMilliseconds(4900));
            Block(() => ledger.Validate(arm, rebound, now.AddSeconds(5)), "SEEK_PARK_EXPIRED");
        });
        Test("cancel invalidates unconsumed transition", () => {
            var ledger = Ledger(); ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now); ledger.FinishPausedProofTransfer();
            Block(() => ledger.Validate(arm, rebound, now), "PREPARATION_OBSERVATION_REPLAYED");
        });
        Test("old adjunct cannot replay after successful rebind", () => {
            var ledger = Ledger(); ledger.AuthorizeSeekKeeperRebind(park, keeper, next, now); ledger.Validate(arm, rebound, now);
            Block(() => ledger.Validate(source, paused, now), "PREPARATION_OBSERVATION_REPLAYED");
        });
        Console.WriteLine($"PASS {count} exact native keeper-rebind ledger cases");
    }
}
