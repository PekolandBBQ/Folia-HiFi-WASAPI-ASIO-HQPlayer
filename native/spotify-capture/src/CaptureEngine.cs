using System.Collections.Concurrent;
using System.Text.Json;

namespace Folia.Capture;

internal sealed class CaptureEngine(Action<object> emit, Func<ControlInterfaceEvidence>? readControlInterface = null, Func<long>? milliseconds = null) : IDisposable
{
    private CaptureSession? current;
    private sealed record SeekPark(CaptureSession Owner, string Token, string Transaction, long ParkedAt,
        CaptureResetBoundary Boundary);
    private SeekPark? seekPark;
    private const int SeekParkTimeoutMs = 5000;
    private long Now => (milliseconds ?? (() => Environment.TickCount64))();
    private OwnedFormatLease? formatLease;
    private readonly CaptureLeaseRegistry leases = new();
    private readonly HelperLifetime lifetime = new();
    private readonly ConcurrentQueue<(CaptureSession Session, string Code)> failures = new();
    private long lastRouteCheck;
    private int? cleanupNativeHResult;
    private (string Session, long Generation)? lastEmittedFailure;

    private static string Text(JsonElement value, string property) => value.TryGetProperty(property, out var field)
        && field.ValueKind == JsonValueKind.String ? field.GetString()! : throw new CaptureFailure("INVALID_REQUEST");
    private static long Generation(JsonElement value) => value.TryGetProperty("generation", out var field)
        && field.TryGetInt64(out var generation) ? generation : throw new CaptureFailure("INVALID_REQUEST");

    internal object Command(JsonElement request)
    {
        lifetime.RequireReusable();
        var action = Text(request, "action");
        if (action == "hello")
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 20348))
                throw new CaptureFailure("PROCESS_CAPTURE_UNSUPPORTED");
            if (!request.TryGetProperty("protocolMajor", out var protocol) || protocol.GetInt32() != 1)
                throw new CaptureFailure("PROTOCOL_INCOMPATIBLE");
            return new { protocolMajor = 1, componentVersion = "0.1.5-capture.10", platform = "win32-x64",
                capabilities = new[] { "windows-process-tree-loopback-v1", "base-vb-cable-capture-v1", "s32le-pipe-v1", "route-process-observation-v1", "temporary-format-lease-v1", "cable-interface-diagnostics-v1", "paused-source-bootstrap-v1", "active-silent-format-lease-v1", "bounded-bootstrap-buffer-v1", "post-start-route-proof-v1", "bounded-playing-seek-device-reuse-v1", "unpublished-position-epoch-v1" },
                sampleRate = 44100, channels = 2, bitDepth = 32, sampleFormat = "s32le",
                queueCapacityBytes = 705600, maximumPacketBytes = 352800,
                bootstrapTimeoutMs = 75000, bootstrapQueueCapacityBytes = 27165600 };
        }
        if (action == "devices")
        {
            var defaults = EndpointInspector.Defaults(); var processes = EndpointInspector.SpotifyProcesses();
            var inventory = EndpointInspector.Devices();
            return new { endpoints = inventory.Endpoints, endpointInventory = inventory.Diagnostics,
                controlInterface = (readControlInterface ?? ControlInterfaceProbe.Read)(), defaults = EndpointInspector.DefaultsObject(defaults), defaultEndpoints = defaults,
                spotifyRunning = processes.Length > 0, spotifyProcesses = processes };
        }
        if (action == "default-endpoints")
        {
            var defaults = EndpointInspector.Defaults();
            return new { defaults = EndpointInspector.DefaultsObject(defaults), defaultEndpoints = defaults };
        }
        if (action == "inspect-route") return Inspect(request);
        if (action == "format-probe") return ProbeFormat(request);
        if (action == "capture-open") return Open(request);
        if (action == "capture-seek-park") return ParkForSeek(request);
        if (action == "close")
        {
            RequireCurrent(request);
            var requestedFormatLease = formatLease != null || current!.FormatLeaseReleased;
            var terminalEvidence = Stop();
            return new { state = "closed", formatLeaseReleased = requestedFormatLease, terminalEvidence };
        }
        var owned = RequireCurrent(request);
        if (action == "capture-start-position-epoch")
        {
            var intent = Text(request, "positionIntentId");
            if (!Guid.TryParseExact(intent, "D", out _)) throw new CaptureFailure("INVALID_REQUEST");
            try
            {
                var epoch = owned.StartPositionEpoch(intent);
                var observedAt = Environment.TickCount64;
                var inspection = EndpointInspector.Inspect(owned.CaptureDeviceId, owned.RenderDeviceId, owned.OutputDeviceId, formatLease);
                inspection = PausedBootstrap.Require(inspection, owned.SpotifyProcess,
                    EndpointInspector.SpotifyProcess(owned.SpotifyProcess.ProcessId));
                if (inspection.Sessions.Any(item => RoutePolicy.IsSpotify(item) && item.State == "active"))
                    throw new CaptureFailure("CAPTURE_POSITION_SOURCE_ACTIVE");
                owned.ConfirmStartValidation(inspection);
                // The command already performed Tick's complete route check. Keep its start time; do not extend freshness.
                lastRouteCheck = observedAt;
                return new { snapshot = owned.Snapshot(), positionEpoch = epoch with { StartValidated = true } };
            }
            catch (Exception error)
            {
                if (error is CaptureFailure failure) owned.Fail(failure); else owned.Fail("CAPTURE_DEVICE_FAILED");
                if (!CleanupSession(owned)) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
                throw;
            }
        }
        if (action == "capture-start")
        {
            owned.RequireStartable();
            try
            {
                // Open checked eligibility before constructing this generation. Start can
                // itself change an engine, so the one full Start inspection must follow it.
                // The generation's PCM gate stays sealed until ConfirmStartValidation.
                owned.Start();
                var inspection = EndpointInspector.Inspect(owned.CaptureDeviceId, owned.RenderDeviceId, owned.OutputDeviceId, formatLease);
                if (owned.BootstrapPending)
                    inspection = PausedBootstrap.Require(inspection, owned.SpotifyProcess,
                        EndpointInspector.SpotifyProcess(owned.SpotifyProcess.ProcessId));
                if (!inspection.Ready && !owned.BootstrapPending)
                {
                    owned.Fail(inspection.Issues[0]);
                    if (!CleanupSession(owned)) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
                    return new { state = "configuration-required", configuration = ReleasedEvidence(inspection),
                        formatLeaseReleased = owned.FormatLeaseReleased };
                }
                owned.ConfirmStartValidation(inspection);
                return owned.Snapshot();
            }
            catch (Exception error)
            {
                if (error is CaptureFailure { Code: "FORMAT_LEASE_READBACK_MISMATCH" } readback) owned.Fail(readback);
                else owned.Fail(error is CaptureFailure failure ? failure.Code : "CAPTURE_DEVICE_FAILED");
                if (!CleanupSession(owned)) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
                throw;
            }
        }
        if (action == "capture-begin-position-epoch")
        {
            owned.RequirePositionEpoch();
            var intent = Text(request, "positionIntentId");
            if (!Guid.TryParseExact(intent, "D", out _)) throw new CaptureFailure("INVALID_REQUEST");
            try
            {
                ConfigurationEvidence PausedInspection()
                {
                    var configuration = EndpointInspector.Inspect(owned.CaptureDeviceId, owned.RenderDeviceId, owned.OutputDeviceId, formatLease);
                    configuration = PausedBootstrap.Require(configuration, owned.SpotifyProcess,
                        EndpointInspector.SpotifyProcess(owned.SpotifyProcess.ProcessId));
                    if (configuration.Sessions.Any(item => RoutePolicy.IsSpotify(item) && item.State == "active"))
                        throw new CaptureFailure("CAPTURE_POSITION_SOURCE_ACTIVE");
                    return configuration;
                }
                owned.ObserveRoute(PausedInspection());
                var epoch = owned.BeginPositionEpoch(intent);
                owned.ConfirmStartValidation(PausedInspection());
                return epoch with { StartValidated = true };
            }
            catch (Exception error)
            {
                if (error is CaptureFailure failure) owned.Fail(failure); else owned.Fail("CAPTURE_DEVICE_FAILED");
                if (!CleanupSession(owned)) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
                throw;
            }
        }
        if (action == "capture-promote")
        {
            owned.RequirePromotable();
            try
            {
                var observedAt = Environment.TickCount64;
                // Promotion always requires the complete ordinary native route checks.
                // Main additionally holds the route service's independent all-endpoint proof.
                var inspection = EndpointInspector.Inspect(owned.CaptureDeviceId, owned.RenderDeviceId, owned.OutputDeviceId, formatLease);
                if (!inspection.Ready) throw new CaptureFailure(inspection.Issues.FirstOrDefault() ?? "ROUTE_OBSERVATION_FAILED");
                owned.SpotifyProcess.RequireBootstrapProcess(EndpointInspector.SpotifyProcess(owned.SpotifyProcess.ProcessId));
                owned.SpotifyProcess.RequireUnchanged(inspection.Sessions);
                owned.ObserveRoute(inspection);
                owned.Promote();
                lastRouteCheck = observedAt;
                return owned.Snapshot();
            }
            catch (Exception error)
            {
                owned.Fail(error is CaptureFailure failure ? failure.Code : "ROUTE_OBSERVATION_FAILED");
                if (!CleanupSession(owned)) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
                throw;
            }
        }
        if (action == "capture-stop")
        {
            var session = owned.Lease.Session; var generation = owned.Lease.Generation;
            var requestedFormatLease = formatLease != null || current!.FormatLeaseReleased;
            var terminalEvidence = Stop();
            return new { session, generation, state = "closed", formatLeaseReleased = requestedFormatLease, terminalEvidence };
        }
        if (action == "status") return owned.Snapshot();
        throw new CaptureFailure("INVALID_REQUEST");
    }

    private ConfigurationEvidence Inspect(JsonElement request)
    {
        var captureId = Text(request, "captureDeviceId"); var renderId = Text(request, "renderDeviceId");
        return EndpointInspector.Inspect(captureId, renderId,
            request.TryGetProperty("outputDeviceId", out var output) && output.ValueKind == JsonValueKind.String ? output.GetString() : null,
            formatLease?.CaptureId == captureId && formatLease.RenderId == renderId ? formatLease : null);
    }

    private object ProbeFormat(JsonElement request)
    {
        if (current != null) throw new CaptureFailure("CAPTURE_BUSY");
        var initial = Inspect(request);
        if (!initial.TemporaryFormatLeaseEligible) return new { state = "configuration-required", configuration = initial };
        OwnedFormatLease? probe = null;
        ConfigurationEvidence verified;
        FormatLeaseEvidence evidence;
        try
        {
            probe = OwnedFormatLease.Acquire(initial);
            verified = EndpointInspector.Inspect(initial.Capture.Id, initial.Render.Id,
                request.TryGetProperty("outputDeviceId", out var output) && output.ValueKind == JsonValueKind.String ? output.GetString() : null, probe);
            if (!verified.Ready) throw new CaptureFailure(verified.Issues[0]);
            evidence = probe.ReadEvidence();
        }
        catch (Exception error)
        {
            var failure = FormatLeasePolicy.CleanupFailure(error, () => probe?.Dispose());
            if (failure.CleanupFailed) { lifetime.Poison(); throw new CaptureFailure("HELPER_RESTART_REQUIRED", failure.NativeHResult); }
            return new { state = "configuration-required", verified = false, errorCode = failure.Code, hresult = failure.NativeHResult, configuration = initial };
        }
        try { probe.Dispose(); }
        catch (Exception error)
        { lifetime.Poison(); throw new CaptureFailure("HELPER_RESTART_REQUIRED", NativeResult(error)); }
        var released = evidence with { State = "released" };
        return new { state = "released", verified = true, configuration = verified with { FormatLease = released }, formatLease = released };
    }

    private object Open(JsonElement request)
    {
        var session = Text(request, "session"); var generation = Generation(request); var pipeName = Text(request, "pipeName");
        var lease = new CaptureLease(session, generation, pipeName);
        if (request.TryGetProperty("seekToken", out _)) return ReopenForSeek(request, lease);
        leases.ValidateNext(lease);
        var inspection = Inspect(request);
        var temporary = request.TryGetProperty("temporaryFormatLease", out var temporaryValue) && temporaryValue.GetBoolean();
        var bootstrap = request.TryGetProperty("bootstrapMode", out _);
        string? bootstrapDelivery = null;
        if (bootstrap)
        {
            if (Text(request, "bootstrapMode") != "paused-source") throw new CaptureFailure("INVALID_REQUEST");
            bootstrapDelivery = Text(request, "bootstrapDelivery");
            if (bootstrapDelivery is not ("discard" or "buffer")) throw new CaptureFailure("INVALID_REQUEST");
        }
        else if (request.TryGetProperty("bootstrapDelivery", out _)) throw new CaptureFailure("INVALID_REQUEST");
        // Bad requests/configuration never tear down the current valid source.
        if (!bootstrap && !inspection.Ready && !(temporary && inspection.TemporaryFormatLeaseEligible))
            return new { state = "configuration-required", configuration = inspection };
        int? expectedPid = request.TryGetProperty("expectedSpotifyProcessId", out var pid) ? pid.GetInt32() : null;
        long? expectedStart = request.TryGetProperty("expectedSpotifyStartedAtUnixMs", out var timestamp) ? timestamp.GetInt64() : null;
        var spotifyProcess = bootstrap
            ? SpotifyProcessLease.BindBootstrap(EndpointInspector.SpotifyProcess(expectedPid ?? throw new CaptureFailure("INVALID_REQUEST")),
                expectedPid!.Value, expectedStart ?? throw new CaptureFailure("INVALID_REQUEST"), Text(request, "expectedSpotifyStartTimeUtcTicks"))
            : SpotifyProcessLease.Bind(inspection.Sessions, expectedPid, expectedStart);
        if (bootstrap) inspection = PausedBootstrap.Require(inspection, spotifyProcess,
            EndpointInspector.SpotifyProcess(spotifyProcess.ProcessId), allowRateMismatch: temporary);
        var releasedPriorOwner = current != null || formatLease != null;
        Stop();
        leases.Reserve(lease);
        var outputId = request.TryGetProperty("outputDeviceId", out var output) && output.ValueKind == JsonValueKind.String ? output.GetString() : null;
        OwnedSilentRenderLeaseEvidence? silentRenderLease = null;
        try
        {
            // Only stopping an existing owner can invalidate this command's preflight.
            // Keep the replacement scan even for a terminal prior session; no cross-command cache.
            if (releasedPriorOwner)
                inspection = EndpointInspector.Inspect(inspection.Capture.Id, inspection.Render.Id, outputId);
            if (bootstrap) inspection = PausedBootstrap.Require(inspection, spotifyProcess,
                EndpointInspector.SpotifyProcess(spotifyProcess.ProcessId), allowRateMismatch: temporary);
            if (!bootstrap && !inspection.Ready && !(temporary && inspection.TemporaryFormatLeaseEligible))
                throw new CaptureFailure(inspection.Issues[0]);
            if (!bootstrap) spotifyProcess.RequireUnchanged(inspection.Sessions);
            if (temporary)
            {
                formatLease = OwnedFormatLease.Acquire(inspection);
                inspection = EndpointInspector.Inspect(inspection.Capture.Id, inspection.Render.Id, outputId, formatLease);
                if (bootstrap) inspection = PausedBootstrap.Require(inspection, spotifyProcess,
                    EndpointInspector.SpotifyProcess(spotifyProcess.ProcessId));
                else
                {
                    if (!inspection.Ready) throw new CaptureFailure(inspection.Issues[0]);
                    spotifyProcess.RequireUnchanged(inspection.Sessions);
                }
            }
            silentRenderLease = formatLease?.AttestSilentRenderLease(lease);
            current = new CaptureSession(lease, inspection.Capture.Id, inspection.Render.Id, outputId,
                inspection, spotifyProcess, (source, code) => failures.Enqueue((source, code)), bootstrapDelivery);
        }
        catch (CaptureFailure failure) when (failure.Code == "CAPTURE_STOP_TIMEOUT" || failure.CleanupFailed)
        {
            lifetime.Poison(); ReleaseFormatLease();
            throw new CaptureFailure("HELPER_RESTART_REQUIRED", failure.NativeHResult);
        }
        catch (CaptureFailure failure) when (temporary)
        {
            ReleaseFormatLease();
            return new { state = "configuration-required", errorCode = failure.Code, hresult = failure.NativeHResult,
                configuration = ReleasedEvidence(inspection) };
        }
        catch { ReleaseFormatLease(); throw; }
        lastRouteCheck = Environment.TickCount64;
        return CaptureOpenEvidence.WithSilentRenderLease(current.Snapshot(), silentRenderLease);
    }

    private object ParkForSeek(JsonElement request)
    {
        var owned = RequireCurrent(request);
        if (seekPark != null || !request.TryGetProperty("sameTrackPlayingSeek", out var sameTrack)
            || sameTrack.ValueKind != JsonValueKind.True) throw new CaptureFailure("CAPTURE_SEEK_INVALID");
        var transaction = Text(request, "seekTransaction");
        if (!Guid.TryParseExact(transaction, "D", out _)) throw new CaptureFailure("INVALID_REQUEST");
        owned.RequirePlayingSeek();
        try
        {
            // This command only proves this capture client's stop/reset. The route
            // service must separately prove source/all-endpoint quiescence.
            var boundary = owned.ParkForSeek();
            seekPark = new(owned, Guid.NewGuid().ToString("D"), transaction, Now, boundary);
            return new { state = "seek-parked", owned.Lease.Session, owned.Lease.Generation,
                seekToken = seekPark.Token, seekTransaction = transaction, expiresInMs = SeekParkTimeoutMs,
                captureStopped = true, captureReset = true, oldGenerationRetired = true,
                retainedInitialized = true, formatLeaseReleased = false, resetBoundary = boundary };
        }
        catch { Stop(); throw; }
    }

    private object ReopenForSeek(JsonElement request, CaptureLease lease)
    {
        var parked = seekPark;
        if (parked == null) throw new CaptureFailure("CAPTURE_SEEK_INVALID");
        // A token has exactly one attempt, including every failure. Never fall
        // through to silently reuse resources after an invalid/expired request.
        seekPark = null;
        try
        {
            leases.ValidateNext(lease);
            if (Text(request, "seekToken") != parked.Token || Text(request, "seekTransaction") != parked.Transaction
                || lease.Session != parked.Owner.Lease.Session) throw new CaptureFailure("CAPTURE_SEEK_INVALID");
            if (Now - parked.ParkedAt is < 0 or >= SeekParkTimeoutMs) throw new CaptureFailure("CAPTURE_SEEK_EXPIRED");
            var output = request.TryGetProperty("outputDeviceId", out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
            if (Text(request, "captureDeviceId") != parked.Owner.CaptureDeviceId
                || Text(request, "renderDeviceId") != parked.Owner.RenderDeviceId || output != parked.Owner.OutputDeviceId
                || !request.TryGetProperty("temporaryFormatLease", out var temporary) || temporary.GetBoolean() != (formatLease != null)
                || Text(request, "bootstrapMode") != "paused-source" || Text(request, "bootstrapDelivery") != "buffer"
                || request.GetProperty("expectedSpotifyProcessId").GetInt32() != parked.Owner.SpotifyProcess.ProcessId
                || request.GetProperty("expectedSpotifyStartedAtUnixMs").GetInt64() != parked.Owner.SpotifyProcess.StartedAtUnixMs
                || Text(request, "expectedSpotifyStartTimeUtcTicks") != parked.Owner.SpotifyProcess.StartedAtUtcTicks)
                throw new CaptureFailure("CAPTURE_SEEK_IDENTITY_CHANGED");
            if (!parked.Owner.RetainedDeviceHealthy) throw new CaptureFailure("CAPTURE_DEVICE_FAILED");
            var inspection = EndpointInspector.Inspect(parked.Owner.CaptureDeviceId, parked.Owner.RenderDeviceId, output, formatLease);
            inspection = PausedBootstrap.Require(inspection, parked.Owner.SpotifyProcess,
                EndpointInspector.SpotifyProcess(parked.Owner.SpotifyProcess.ProcessId));
            if (inspection.Capture.MixFormat != parked.Owner.Configuration.Capture.MixFormat)
                throw new CaptureFailure("CAPTURE_FORMAT_CHANGED");
            if (Now - parked.ParkedAt is < 0 or >= SeekParkTimeoutMs) throw new CaptureFailure("CAPTURE_SEEK_EXPIRED");
            leases.Reserve(lease);
            var silent = formatLease?.AttestSilentRenderLease(lease);
            current = parked.Owner.Reopen(lease, inspection, (source, code) => failures.Enqueue((source, code)), "buffer");
            parked.Owner.Dispose();
            lastRouteCheck = Environment.TickCount64;
            return CaptureOpenEvidence.WithSilentRenderLease(current.Snapshot(), silent);
        }
        catch
        {
            // Reopen may fail before attaching a new generation. Dispose the
            // retained owner explicitly as well as normal engine cleanup.
            try { parked.Owner.ReleaseRetainedDevice(); }
            catch (Exception error) { lifetime.Poison(); cleanupNativeHResult ??= NativeResult(error); }
            Stop(); throw;
        }
    }

    private CaptureSession RequireCurrent(JsonElement request)
    {
        var session = Text(request, "session"); var generation = Generation(request);
        var owned = current ?? throw new CaptureFailure("STALE_GENERATION");
        owned.Lease.RequireOwner(session, generation); return owned;
    }

    private void DrainFailures()
    {
        while (failures.TryDequeue(out var failure))
            if (ReferenceEquals(current, failure.Session))
            {
                var cleaned = CleanupSession(failure.Session);
                EmitFailure(failure.Session, failure.Session.TerminalEvidence(cleaned));
            }
    }

    // Pipe EOF can reach main before its queued fault event. A stop receipt and
    // same-generation event preserve the native cause even when Stop wins Tick.
    private void EmitFailure(CaptureSession session, CaptureTerminalEvidence terminalEvidence)
    {
        var identity = (session.Lease.Session, session.Lease.Generation);
        if (terminalEvidence.State != "failed" || terminalEvidence.ErrorCode == null
            || lastEmittedFailure == identity) return;
        lastEmittedFailure = identity;
        emit(new { @event = "capture-error", session.Lease.Session, session.Lease.Generation,
            errorCode = terminalEvidence.ErrorCode, formatLeaseReleased = session.FormatLeaseReleased,
            helperRestartRequired = !terminalEvidence.CleanupConfirmed, terminalEvidence });
    }

    internal void Tick()
    {
        DrainFailures();
        if (seekPark is { } parked)
        {
            if (Now - parked.ParkedAt is < 0 or >= SeekParkTimeoutMs || !parked.Owner.RetainedDeviceHealthy)
            { Stop(); return; }
            if (Environment.TickCount64 - lastRouteCheck >= 250)
            {
                lastRouteCheck = Environment.TickCount64;
                try
                {
                    var configuration = EndpointInspector.Inspect(parked.Owner.CaptureDeviceId,
                        parked.Owner.RenderDeviceId, parked.Owner.OutputDeviceId, formatLease);
                    PausedBootstrap.Require(configuration, parked.Owner.SpotifyProcess,
                        EndpointInspector.SpotifyProcess(parked.Owner.SpotifyProcess.ProcessId));
                    if (configuration.Capture.MixFormat != parked.Owner.Configuration.Capture.MixFormat)
                        throw new CaptureFailure("CAPTURE_FORMAT_CHANGED");
                }
                catch { Stop(); }
            }
            return;
        }
        var owned = current;
        if (owned == null || owned.Terminal || Environment.TickCount64 - lastRouteCheck < 250) return;
        lastRouteCheck = Environment.TickCount64;
        try
        {
            var configuration = EndpointInspector.Inspect(owned.CaptureDeviceId, owned.RenderDeviceId, owned.OutputDeviceId, formatLease);
            if (owned.BootstrapPending) configuration = PausedBootstrap.Require(configuration, owned.SpotifyProcess,
                EndpointInspector.SpotifyProcess(owned.SpotifyProcess.ProcessId));
            if (!configuration.Ready && !owned.BootstrapPending) owned.Fail(configuration.Issues[0]);
            else owned.ObserveRoute(configuration);
        }
        catch (CaptureFailure failure)
        {
            if (failure.Code == "FORMAT_LEASE_READBACK_MISMATCH") owned.Fail(failure);
            else owned.Fail(failure.Code);
        }
        catch { owned.Fail("ROUTE_OBSERVATION_FAILED"); }
        DrainFailures();
    }

    private static int? NativeResult(Exception error) => error is CaptureFailure failure ? failure.NativeHResult
        : error is System.Runtime.InteropServices.COMException ? error.HResult : null;

    private static ConfigurationEvidence ReleasedEvidence(ConfigurationEvidence configuration) =>
        configuration with { FormatLease = configuration.FormatLease is { } evidence ? evidence with { State = "released" } : null };

    // Native thread shutdown and both format releases are independent cleanup obligations.
    // Never allow a failed cleanup to bypass the second obligation or escape the Tick loop.
    private bool CleanupSession(CaptureSession session)
    {
        try { session.Dispose(); }
        catch (Exception error) { lifetime.Poison(); cleanupNativeHResult ??= NativeResult(error); }
        try { ReleaseFormatLease(session); }
        catch (Exception error) { lifetime.Poison(); cleanupNativeHResult ??= NativeResult(error); }
        return !lifetime.RestartRequired;
    }

    private CaptureTerminalEvidence? Stop()
    {
        var previous = current; current = null;
        var parked = seekPark; seekPark = null;
        if (parked != null)
        {
            try { parked.Owner.ReleaseRetainedDevice(); }
            catch (Exception error) { lifetime.Poison(); cleanupNativeHResult ??= NativeResult(error); }
        }
        if (previous != null)
        {
            var cleaned = CleanupSession(previous);
            var terminalEvidence = previous.TerminalEvidence(cleaned);
            EmitFailure(previous, terminalEvidence);
            if (!cleaned) throw new CaptureFailure("HELPER_RESTART_REQUIRED", cleanupNativeHResult);
            return terminalEvidence;
        }
        else ReleaseFormatLease();
        return null;
    }

    private void ReleaseFormatLease(CaptureSession? owner = null)
    {
        var lease = formatLease; formatLease = null;
        if (lease == null) return;
        try { lease.Dispose(); }
        catch (Exception error)
        {
            lifetime.Poison();
            (owner ?? current)?.ObserveFormatLeaseReleaseFailed();
            throw new CaptureFailure("HELPER_RESTART_REQUIRED", NativeResult(error));
        }
        (owner ?? current)?.ObserveFormatLeaseReleased();
    }

    public void Dispose() => Stop();
}
