using System.Text.Json;
using Folia.ProductRoute;

// Actual production service/verifier/ledger; only OS/capture observations are boundary fixtures.
internal static class SeekParkContractTests
{
    internal static void Run()
    {
        int count = 0;
        void Check(bool ok, string why) { if (!ok) throw new Exception(why); }
        void Ok(ServiceReply value) => Check(value.Ok, value.Code + "/" + value.State);
        void Test(string name, Action body) { body(); count++; Console.WriteLine("PASS seek-park " + name); }
        JsonElement Wire(OwnedSeekParkReceipt receipt) => JsonSerializer.SerializeToElement(receipt, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        OwnedSeekParkReceipt Receipt(Fixture f) => new("seek-parked", "session", 1, Guid.NewGuid().ToString("D"), Guid.NewGuid().ToString("D"),
            5000, true, true, true, true, false, new("session", 1, 1, f.Now.ToUnixTimeMilliseconds()));
        (Fixture F, OwnedSeekParkReceipt Receipt, ServiceReply Parked) Park(bool processCapture = false)
        {
            var f = new Fixture { RequiresTargetEndpointActivity = !processCapture, EmptyProcessSessions = processCapture }; f.Prepare(); f.Start(1); f.Paused = true; f.PcmStopped = false; f.ResetReceipt();
            var receipt = Receipt(f); f.CaptureParkReceipt = receipt;
            var parked = f.Send("seekPark", new { intervalEpoch = 1, seekTransaction = receipt.SeekTransaction,
                captureParkReceipt = Wire(receipt), reusePauseObservation = true }); Ok(parked);
            return (f, receipt, parked);
        }
        ServiceReply Resume(Fixture f, OwnedSeekParkReceipt receipt, ServiceReply parked) => f.Send("seekResumePreparation",
            new { intervalEpoch = 2, selectedSourceUri = Fixture.Track, seekTransaction = receipt.SeekTransaction, seekRouteToken = parked.SeekRouteToken });
        void Complete(Fixture f) { Ok(f.Send("completePreparedSelection", new { intervalEpoch = 2 })); f.OpenRetainedCapture(); }
        Test("distinct park retains ownership, retires interval, and uses fresh interval with same keeper", () => {
            var x = Park(); using var f = x.F; var writes = f.Writes;
            Check(x.Parked.State == "seekParked" && x.Parked.SeekParked && !x.Parked.Ready && !x.Parked.IntervalArmed && f.SeekRetained, "Park published interval");
            Ok(Resume(f, x.Receipt, x.Parked)); Complete(f);
            Ok(f.Send("armCaptureInterval", new { ownedSilentRenderLease = new { captureSession = "session", captureGeneration = 2,
                endpointId = "render", sessionInstanceId = "keeper1", groupingId = "26377ba7-2d95-407a-b2b7-7131377305c2", processId = 20, startedAtUtcTicks = "639271242001234567" } }));
            Ok(f.Send("authorizeResume", new { selectedSourceUri = Fixture.Track, captureStarted = true, monitorGainZero = true }));
            f.Paused = false; f.PcmStopped = false; f.ResetReceipt(); Check(f.Send("status").Ready, "New interval not ready");
            Check(f.Writes == writes, "Seek rewrote routing policy");
        });
        Test("process capture without active endpoint resumes bounded Seek and cancels to ordinary Pause", () => {
            var x = Park(true); using var f = x.F; var writes = f.Writes;
            Ok(Resume(f, x.Receipt, x.Parked)); Complete(f);
            f.PcmStopped=true;f.CaptureParkReceipt=null;f.ResetReceipt();
            Ok(f.Send("seekCancelToPaused",new {seekTransaction=x.Receipt.SeekTransaction,intervalEpoch=2}));
            Ok(f.Send("resumePreparation",new {intervalEpoch=3,selectedSourceUri=Fixture.Track}));
            Ok(f.Send("completePreparedSelection",new {intervalEpoch=3}));
            Check(f.Writes==writes,"Process Seek rewrote route");Ok(f.Send("release"));f.CheckOriginals();
        });
        var receiptFaults = new Func<OwnedSeekParkReceipt, OwnedSeekParkReceipt>[] {
            p => p with { CaptureStopped = false }, p => p with { CaptureReset = false }, p => p with { OldGenerationRetired = false },
            p => p with { RetainedInitialized = false }, p => p with { FormatLeaseReleased = true }, p => p with { ExpiresInMs = 6000 },
            p => p with { Generation = 2 }, p => p with { Session = "other" }, p => p with { SeekToken = "not-a-token" },
            p => p with { ResetBoundary = p.ResetBoundary with { PreviousGeneration = 2 } },
            p => p with { ResetBoundary = p.ResetBoundary with { ResetSequence = 0 } },
            p => p with { ResetBoundary = p.ResetBoundary with { StoppedAndResetAtUnixMs = p.ResetBoundary.StoppedAndResetAtUnixMs + 1 } }
        };
        for (var index = 0; index < receiptFaults.Length; index++) { var fault = receiptFaults[index]; Test("reject malformed or mismatched capture receipt " + index, () => {
            using var f = new Fixture(); f.Prepare(); f.Start(1); f.Paused = true; f.PcmStopped = false; f.ResetReceipt();
            var receipt = fault(Receipt(f)); f.CaptureParkReceipt = receipt;
            var result = f.Send("seekPark", new { intervalEpoch = 1, seekTransaction = receipt.SeekTransaction,
                captureParkReceipt = Wire(receipt), reusePauseObservation = true });
            Check(!result.Ok && !f.SeekRetained, "Malformed receipt retained native resources");
        }); }
        Test("ordinary Pause still rejects retained keeper as full-stop evidence", () => {
            using var f = new Fixture(); f.Prepare(); f.Start(1); f.Paused = true; f.PcmStopped = false; f.ResetReceipt();
            var result = f.Send("suspendPaused", new { intervalEpoch = 1 }); Check(!result.Ok && result.Code == "PCM_STOP_NOT_CONFIRMED", result.Code);
        });
        Test("fresh stop/reset evidence cannot be asserted only in route command", () => {
            using var f = new Fixture(); f.Prepare(); f.Start(1); f.Paused = true; f.PcmStopped = false; f.ResetReceipt(); var receipt = Receipt(f);
            var result = f.Send("seekPark", new { intervalEpoch = 1, seekTransaction = receipt.SeekTransaction, captureParkReceipt = Wire(receipt), reusePauseObservation = true });
            Check(!result.Ok && result.Code == "SEEK_PARK_EVIDENCE_REQUIRED", result.Code);
        });
        foreach (var fault in new[] { "token", "transaction", "epoch", "track" }) Test("wrong " + fault + " cannot resume", () => {
            var x = Park(); using var f = x.F;
            var result = f.Send("seekResumePreparation", new { intervalEpoch = fault == "epoch" ? 1 : 2,
                selectedSourceUri = fault == "track" ? Fixture.Other : Fixture.Track,
                seekTransaction = fault == "transaction" ? Guid.NewGuid().ToString("D") : x.Receipt.SeekTransaction,
                seekRouteToken = fault == "token" ? Guid.NewGuid().ToString("D") : x.Parked.SeekRouteToken });
            Check(!result.Ok && f.IntervalId is null, "Fault armed interval");
            Check(!Resume(f, x.Receipt, x.Parked).Ok, "Failed attempt did not burn token");
        });
        Test("five-second park expires without sampling; full stop still restores", () => {
            var x = Park(); using var f = x.F; f.Advance(TimeSpan.FromSeconds(5));
            var result = Resume(f, x.Receipt, x.Parked); Check(!result.Ok && result.Code == "SEEK_PARK_EXPIRED", result.Code);
            f.PcmStopped = true; f.CaptureParkReceipt = null; f.ResetReceipt(); Ok(f.Send("release")); f.CheckOriginals();
        });
        Test("ordinary resume cannot adopt a bounded parked route", () => {
            var x = Park(); using var f = x.F;
            Check(!f.Send("resumePreparation", new { intervalEpoch = 2, selectedSourceUri = Fixture.Track }).Ok, "Ordinary resume accepted retained resources");
        });
        Test("keeper identity change at fresh arm is rejected", () => {
            var x = Park(); using var f = x.F; Ok(Resume(f, x.Receipt, x.Parked)); Complete(f);
            var result = f.Arm(2); Check(!result.Ok && result.Code == "SEEK_PARK_KEEPER_CHANGED" && f.IntervalId is null, result.Code);
        });
        Test("C receipt transfers independently while retained capture remains explicit evidence", () => {
            var x = Park(); using var f = x.F; Check(x.Parked.PausedProofTransferId is not null, "No source transfer");
            Ok(f.Send("seekResumePreparation", new { intervalEpoch = 2, selectedSourceUri = Fixture.Track,
                seekTransaction = x.Receipt.SeekTransaction, seekRouteToken = x.Parked.SeekRouteToken,
                pausedProofTransferId = x.Parked.PausedProofTransferId, resumeIntentId = Guid.NewGuid().ToString("D") }));
            var sourceBefore = f.LastReceipt;
            Complete(f);
            if (sourceBefore is null || f.LastReceipt is null || !PreparationObservationLedger.SameReceipt(sourceBefore with { CaptureParkReceipt = null }, f.LastReceipt))
                throw new Exception("Capture open changed original source receipt");
            Ok(f.Send("armCaptureInterval", new { ownedSilentRenderLease = new { captureSession = "session", captureGeneration = 2,
                endpointId = "render", sessionInstanceId = "keeper1", groupingId = "26377ba7-2d95-407a-b2b7-7131377305c2", processId = 20, startedAtUtcTicks = "639271242001234567" } }));
            Ok(f.Send("authorizeResume", new { selectedSourceUri = Fixture.Track, captureStarted = true, monitorGainZero = true }));
        });
        foreach (var phase in new[] { "parked", "resuming", "completed" }) Test("full-stop cancellation from " + phase + " becomes indefinite Pause", () => {
            var x = Park(); using var f = x.F;
            if (phase != "parked") Ok(Resume(f, x.Receipt, x.Parked));
            if (phase == "completed") Complete(f);
            f.PcmStopped = true; f.CaptureParkReceipt = null; f.ResetReceipt();
            var epoch = phase == "parked" ? 1 : 2;
            var cancel = f.Send("seekCancelToPaused", new { seekTransaction = x.Receipt.SeekTransaction, intervalEpoch = epoch }); Ok(cancel);
            Check(cancel.State == "pausedHeld" && cancel.PausedHeld && !cancel.Ready && !cancel.IntervalArmed && !f.SeekRetained, "Cancellation retained initialized resource");
            var reads = f.SourceReads; var scans = f.SessionScans;
            for (var n = 0; n < 100; n++) { f.Advance(TimeSpan.FromSeconds(4)); Ok(f.Send("heartbeat")); }
            Check(f.SourceReads == reads && f.SessionScans == scans, "Indefinite pause sampled audio");
            Ok(f.Send("resumePreparation", new { intervalEpoch = epoch + 1, selectedSourceUri = Fixture.Track }));
        });
        Test("cancel-to-Pause refuses a retained capture that has not fully stopped", () => {
            var x = Park(); using var f = x.F;
            var cancel = f.Send("seekCancelToPaused", new { seekTransaction = x.Receipt.SeekTransaction, intervalEpoch = 1 });
            Check(!cancel.Ok && cancel.Code == "PCM_STOP_NOT_CONFIRMED" && f.SeekRetained, cancel.Code);
        });
        Console.WriteLine($"PASS {count} bounded native seek-park service cases");
    }
}
