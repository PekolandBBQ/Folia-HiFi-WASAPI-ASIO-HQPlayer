using Folia.ProductRoute;
using Folia.RouteResearch;

// Production ledger tests use immutable source receipts; no HTTP or Windows calls.
internal static class TransferContractTests
{
    internal static void Run()
    {
        var count = 0; var caseNumber = 0;
        var now = Fixture.StartTime;
        OwnedPlaybackTarget held = new("device", Fixture.Track, Fixture.Identity, RequirePcmStopped: true,
            RequirePreparationObservation: true, PreparationPhase: "selected", RequirePausedHoldObservation: true);
        PlaybackStatus receipt = new("device", Fixture.Track, false, now, true, true, false, 8, 5, "selected", 17000);
        void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
        void Reject(Action action, string code)
        { try { action(); throw new Exception("Expected " + code); } catch (RouteBlockedException error) { Check(error.Message == code, error.Message); } }
        void Test(string name, Action body) { body(); count++; Console.WriteLine("PASS transfer " + name); }
        (PreparationObservationLedger Ledger, OwnedPlaybackTarget Resume, string Id, string Intent) Offer()
        {
            var ledger = new PreparationObservationLedger(); ledger.Validate(held, receipt, now);
            var id = Guid.NewGuid().ToString("D"); var intent = Guid.NewGuid().ToString("D");
            Check(ledger.IssuePausedProofTransfer(id, held, now), "Missing native offer");
            return (ledger, held with { RequirePausedHoldObservation = false, RequirePreparedSelection = true,
                PreparationSelectedSourceUri = Fixture.Track, PausedProofTransferId = id, ResumeIntentId = intent }, id, intent);
        }
        Test("exact receipt crosses native scan without changing generation, epoch, phase, position or timestamp", () => {
            var x = Offer(); x.Ledger.BeginResumePreparation(x.Id, x.Intent);
            x.Ledger.Validate(x.Resume, receipt, now.AddMilliseconds(1)); x.Ledger.Validate(x.Resume, receipt, now.AddMilliseconds(499));
            x.Ledger.FinishPausedProofTransfer();
            x.Ledger.Validate(x.Resume with { PausedProofTransferId = null, ResumeIntentId = null }, receipt, now.AddMilliseconds(501));
        });
        foreach (var changed in new[] { receipt with { ObservationGeneration = 9 }, receipt with { MutationEpoch = 6 },
            receipt with { ObservedAtUtc = now.AddMilliseconds(1) }, receipt with { PreparationPhase = "baseline" },
            receipt with { PositionMs = 18000 }, receipt with { DeviceId = "other" }, receipt with { TrackUri = Fixture.Other },
            receipt with { IsPlaying = true }, receipt with { PcmStopped = false }, receipt with { PreparationOwned = false },
            receipt with { PlaybackRequestPending = true }, receipt with { EmptyPlayer = true } })
            Test("changed source receipt is rejected " + ++caseNumber, () => {
                var x = Offer(); x.Ledger.BeginResumePreparation(x.Id, x.Intent);
                Reject(() => x.Ledger.Validate(x.Resume, changed, now), "PAUSED_PROOF_TRANSFER_INVALID");
            });
        foreach (var change in new Func<OwnedPlaybackTarget, OwnedPlaybackTarget>[] {
            t => t with { PausedProofTransferId = Guid.NewGuid().ToString("D") }, t => t with { ResumeIntentId = Guid.NewGuid().ToString("D") },
            t => t with { DeviceId = "other" }, t => t with { TrackUri = Fixture.Other }, t => t with { Process = Fixture.Identity with { Pid = 13 } },
            t => t with { PreparationPhase = "baseline" }, t => t with { RequirePcmStopped = false }, t => t with { RequirePreparedSelection = false } })
            Test("changed transfer target is rejected " + ++caseNumber, () => {
                var x = Offer(); x.Ledger.BeginResumePreparation(x.Id, x.Intent);
                Reject(() => x.Ledger.Validate(change(x.Resume), receipt, now), "PAUSED_PROOF_TRANSFER_INVALID");
            });
        Test("500 ms expiry is exact and never refreshes receipt", () => {
            var x = Offer(); x.Ledger.BeginResumePreparation(x.Id, x.Intent);
            Reject(() => x.Ledger.Validate(x.Resume, receipt, now.AddMilliseconds(500)), "PAUSED_PROOF_TRANSFER_EXPIRED");
        });
        Test("future and expired receipts cannot issue a transfer", () => {
            var x = Offer(); Check(!x.Ledger.IssuePausedProofTransfer(x.Id, held, now.AddMilliseconds(-1)), "Future accepted");
            Check(!x.Ledger.IssuePausedProofTransfer(x.Id, held, now.AddMilliseconds(500)), "Expired accepted");
        });
        Test("nonce cannot be consumed twice or by another ledger", () => {
            var x = Offer(); x.Ledger.BeginResumePreparation(x.Id, x.Intent);
            Reject(() => x.Ledger.BeginResumePreparation(x.Id, Guid.NewGuid().ToString("D")), "PAUSED_PROOF_TRANSFER_INVALID");
            Reject(() => new PreparationObservationLedger().BeginResumePreparation(x.Id, x.Intent), "PAUSED_PROOF_TRANSFER_INVALID");
        });
        Test("failed nonce consume burns the offer", () => {
            var x = Offer(); Reject(() => x.Ledger.BeginResumePreparation(Guid.NewGuid().ToString("D"), x.Intent), "PAUSED_PROOF_TRANSFER_INVALID");
            Reject(() => x.Ledger.BeginResumePreparation(x.Id, x.Intent), "PAUSED_PROOF_TRANSFER_INVALID");
        });
        Test("finish and ordinary resume invalidate the offered token", () => {
            var x = Offer(); x.Ledger.FinishPausedProofTransfer(); Reject(() => x.Ledger.BeginResumePreparation(x.Id, x.Intent), "PAUSED_PROOF_TRANSFER_INVALID");
            x = Offer(); x.Ledger.BeginResumePreparation(); Reject(() => x.Ledger.BeginResumePreparation(x.Id, x.Intent), "PAUSED_PROOF_TRANSFER_INVALID");
        });
        Test("ordinary baseline replay remains forbidden; genuine newer receipt passes", () => {
            var x = Offer(); x.Ledger.BeginResumePreparation();
            var baseline = held with { RequirePausedHoldObservation = false, PreparationPhase = "baseline" };
            Reject(() => x.Ledger.Validate(baseline, receipt with { PreparationPhase = "baseline" }, now), "PREPARATION_OBSERVATION_REPLAYED");
            Reject(() => x.Ledger.Validate(baseline, receipt with { PreparationPhase = "baseline", ObservationGeneration = 9 }, now), "PREPARATION_OBSERVATION_REPLAYED");
            x.Ledger.Validate(baseline, receipt with { PreparationPhase = "baseline", ObservationGeneration = 9, MutationEpoch = 6 }, now);
        });
        Console.WriteLine($"PASS {count} transfer contract assertions");
    }
}
