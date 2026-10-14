using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;
using Folia.RouteRunner;

// Performance.Tests/SourceOwnerContractTests.cs: real service, ledger and recovery
// scope with mock Windows policy boundaries; never executes Windows or HTTP.
internal static class SourceOwnerContractTests
{
    internal static void Run()
    {
        var count = 0;
        void Check(bool value, string label) { if (!value) throw new Exception(label); }
        void Ok(ServiceReply value) => Check(value.Ok, value.Code + ": " + value.State);
        JsonElement Lease(ServiceReply value) => JsonSerializer.SerializeToElement(value.Lease);
        void Test(string name, Action run) { run(); count++; Console.WriteLine("PASS source-owner " + name); }
        Fixture Held() { var f = new Fixture(); f.Prepare(); f.Start(1); f.Pause(); return f; }
        ServiceReply Rebind(Fixture f, string selected = Fixture.Other, int sourceEpoch = 2, int intervalEpoch = 2,
            string previous = Fixture.Track) => f.Send("rebindPreparedSelection", new {
                selectedSourceUri = selected, pausedSourceUri = previous, sourceEpoch, intervalEpoch });
        void SelectAndPark(Fixture f, string selected, int intervalEpoch)
        {
            f.TrackUri = selected; f.Paused = false; f.ResetReceipt();
            Ok(f.Send("verifyPreparedTargetActive", new { selectedSourceUri = selected, intervalEpoch }));
            f.Paused = true; f.ResetReceipt();
            Ok(f.Send("completePreparedSelection", new { intervalEpoch }));
        }
        Test("held validation preserves exact original journal and performs no discovery or setter", () => {
            using var f = Held(); var original = f.Latest; var writes = f.Writes; var reads = f.SourceReads;
            var value = f.Send("validateHeld", new { captureDeviceId = "capture", renderDeviceId = "render", sourceDeviceId = "device", intervalEpoch = 1 });
            Ok(value); Check(value.Code == "HELD_ROUTE_VALIDATED" && !value.Ready && !value.IntervalArmed, "Invalid held ACK");
            Check(f.Latest == original && f.Writes == writes && f.SourceReads == reads, "Held validation changed routing or source");
        });
        Test("new track rebind preserves lease journal and raw nullable originals until one final restore", () => {
            using var f = Held(); var before = f.Send("heartbeat"); var journal = f.Latest; var writes = f.Writes; var reads = f.SourceReads;
            var next = Rebind(f); Ok(next);
            Check(next.PreparedSelectionAuthorized && !next.PreparedTargetActive && !next.Ready && !next.IntervalArmed, "Old activity became new permission");
            Check(next.IntervalEpoch == 2 && Lease(next).GetProperty("sourceEpoch").GetInt32() == 2, "Missing independent epochs");
            Check(Lease(next).GetProperty("leaseId").GetString() == Lease(before).GetProperty("leaseId").GetString(), "Lease replaced");
            Check(f.Latest == journal && f.Writes == writes && f.SourceReads == reads + 2, "Rebind rediscovered, journaled, wrote or skipped scan-fenced reads");
            Check(!f.Send("completePreparedSelection", new { intervalEpoch = 2 }).Ok, "Old activity completed new selection");
            SelectAndPark(f, Fixture.Other, 2);
            Check(!f.Arm(1).Ok, "Old capture generation reused"); Ok(f.Arm(2));
            Ok(f.Send("authorizeResume", new { selectedSourceUri = Fixture.Other, captureStarted = true, monitorGainZero = true }));
            f.Paused = false; f.PcmStopped = false; f.ResetReceipt(); Ok(f.Send("status"));
            Check(f.Writes == writes, "Track transition applied policy again");
            f.Paused = true; f.PcmStopped = true; f.ResetReceipt(); Ok(f.Send("suspendPaused", new { intervalEpoch = 2 }));
            Ok(f.Send("release")); f.CheckOriginals(); Check(f.Writes == writes + 2, "Final restore did not write each original exactly once");
        });
        Test("same URI repeat cannot transplant prior active witness", () => {
            using var f = Held(); Ok(Rebind(f, Fixture.Track));
            Check(!f.Send("completePreparedSelection", new { intervalEpoch = 2 }).Ok, "Same URI reused old activity");
            SelectAndPark(f, Fixture.Track, 2); Check(!f.Send("heartbeat").Ready, "Prepared repeat published");
        });
        Test("A B A repeats advance source and interval epochs without another policy acquire", () => {
            using var f = Held(); var writes = f.Writes;
            Ok(Rebind(f)); SelectAndPark(f, Fixture.Other, 2); Ok(f.Send("suspendPaused", new { intervalEpoch = 2 }));
            Ok(Rebind(f, Fixture.Track, 3, 3, Fixture.Other)); SelectAndPark(f, Fixture.Track, 3);
            Check(Lease(f.Send("heartbeat")).GetProperty("sourceEpoch").GetInt32() == 3 && f.Writes == writes, "ABA reused owner epoch or route setter");
        });
        foreach (var invalid in new[] { "sourceEpoch", "intervalEpoch", "oldUri", "newUri", "proofTransfer", "session", "generation" })
            Test("rebind rejects wrong " + invalid + " before source mutation", () => {
                using var f = Held(); var reads = f.SourceReads; var writes = f.Writes;
                var payload = new Dictionary<string, object?> { ["sourceEpoch"] = 2, ["intervalEpoch"] = 2,
                    ["pausedSourceUri"] = Fixture.Track, ["selectedSourceUri"] = Fixture.Other };
                if (invalid == "sourceEpoch") payload["sourceEpoch"] = 1;
                if (invalid == "intervalEpoch") payload["intervalEpoch"] = 1;
                if (invalid == "oldUri") payload["pausedSourceUri"] = Fixture.Other;
                if (invalid == "newUri") payload["selectedSourceUri"] = "spotify:track:invalid";
                if (invalid == "proofTransfer") payload["pausedProofTransferId"] = Guid.NewGuid().ToString("D");
                if (invalid == "session") payload["session"] = "different";
                if (invalid == "generation") payload["generation"] = 2;
                var result = f.Send("rebindPreparedSelection", payload);
                Check(!result.Ok && f.SourceReads == reads && f.Writes == writes, "Invalid input reached source or policy");
                Check(Lease(result).GetProperty("sourceEpoch").GetInt32() == 1 && result.IntervalEpoch == 1, "Failure committed epoch");
            });
        foreach (var fault in new[] { "playing", "pcm", "changedTrack", "duringScan", "process", "endpoint", "authority", "journalOwner" })
            Test("failed " + fault + " proof blocks without committing epochs or changing original route", () => {
                using var f = Held(); var writes = f.Writes;
                if (fault == "playing") f.Paused = false;
                if (fault == "pcm") f.PcmStopped = false;
                if (fault == "changedTrack") f.TrackUri = Fixture.Other;
                if (fault == "duringScan") f.ChangeDuringScan = true;
                if (fault == "process") f.ProcessChanged = true;
                if (fault == "endpoint") f.EndpointChanged = true;
                if (fault == "authority") f.AuthorityLost = true;
                if (fault == "journalOwner") f.JournalOwnerLost = true;
                f.ResetReceipt(); var result = Rebind(f);
                Check(!result.Ok && !result.Ready && !result.IntervalArmed && f.Writes == writes && f.Service.HasLease, "Fault allowed playback or released owner");
                Check(Lease(result).GetProperty("sourceEpoch").GetInt32() == 1 && result.IntervalEpoch == 1, "Fault committed epoch");
            });
        Test("heartbeat during new selection never transfers active or capture permission", () => {
            using var f = Held(); Ok(Rebind(f));
            var writes = f.Writes; var reads = f.SourceReads;
            for (var n = 0; n < 5; n++) { f.Advance(TimeSpan.FromSeconds(4)); var beat = f.Send("heartbeat"); Ok(beat); Check(!beat.Ready && !beat.IntervalArmed && beat.State == "preparedSelection", "Heartbeat became ready"); }
            Check(f.SourceReads == reads && f.Writes == writes, "Heartbeat reread source or wrote policy");
        });
        Test("new source epoch cannot consume prior paused transfer nonce", () => {
            var ledger = new PreparationObservationLedger(); var now = Fixture.StartTime;
            var held = new OwnedPlaybackTarget("device", Fixture.Track, Fixture.Identity, RequirePcmStopped: true,
                RequirePreparationObservation: true, PreparationPhase: "selected", RequirePausedHoldObservation: true);
            var receipt = new PlaybackStatus("device", Fixture.Track, false, now, true, true, false, 8, 5, "selected", 17000);
            ledger.Validate(held, receipt, now); var id = Guid.NewGuid().ToString("D"); var intent = Guid.NewGuid().ToString("D");
            Check(ledger.IssuePausedProofTransfer(id, held, now), "No offer"); ledger.BeginResumePreparation(id, intent);
            try { ledger.Validate(held with { RequirePausedHoldObservation = false, RequirePreparedSelection = true,
                PreparationSelectedSourceUri = Fixture.Track, PausedProofTransferId = id, ResumeIntentId = intent, SourceEpoch = 2 }, receipt, now);
                throw new Exception("Transfer crossed source epoch"); }
            catch (RouteBlockedException error) { Check(error.Message == "PAUSED_PROOF_TRANSFER_INVALID", error.Message); }
        });
        Test("supervisor recovery source advances only for successful exact track-rebind ACK", () => {
            var source = new OwnedPlaybackTarget("device", Fixture.Track, Fixture.Identity);
            var baseline = new ProductRecoveryBaseline(["physical", "physical", "physical"], source, new("capture", "render"));
            var payload = JsonSerializer.SerializeToElement(new { selectedSourceUri = Fixture.Other, pausedSourceUri = Fixture.Track, sourceEpoch = 2 });
            var success = new ServiceReply("test", true, "preparedSelection", "TRACK_PREPARATION_AUTHORIZED", PreparedSelectionAuthorized: true);
            var next = ProductSourceRecoveryScope.Advance("rebindPreparedSelection", payload, success, baseline)!;
            Check(next.Source.TrackUri == Fixture.Other && next.Source.SourceEpoch == 2 && next.Source.PausedPreviousTrackUri == Fixture.Track, "Recovery lost exact old/new binding");
            Check(ProductSourceRecoveryScope.Advance("rebindPreparedSelection", payload, success with { Ok = false }, baseline) == baseline, "Failed ACK advanced recovery epoch");
        });
        Console.WriteLine($"PASS {count} source-owner contract assertions (mock Windows boundaries only)");
    }
}
