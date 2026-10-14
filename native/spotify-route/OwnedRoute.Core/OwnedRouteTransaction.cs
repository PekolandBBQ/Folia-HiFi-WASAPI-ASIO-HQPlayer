namespace Folia.RouteResearch;

/// <summary>
/// Application-owned compensation for persistent per-app policy. NOT an OS temporary
/// lease: killing this object/helper leaves policy intact until successful recovery.
/// </summary>
public sealed class OwnedRouteTransaction(IVerifiedSpotifyResolver resolver,
    ISelectedEndpointVerifier endpointVerifier, ISessionObserver observer,
    IDurableRouteJournal journal, Func<DateTimeOffset>? clock = null, Func<bool>? cancelRequested = null)
{
    private readonly object gate = new();
    private readonly Func<DateTimeOffset> now = clock ?? (() => DateTimeOffset.UtcNow);
    private static readonly RenderRole[] AllRoles = Enum.GetValues<RenderRole>();
    private static readonly TimeSpan SessionBudget = TimeSpan.FromSeconds(5);
    private RouteRecord? current;

    public RouteRecord? Inspect() { lock (gate) return Load(); }

    public RouteRecord Begin(SpotifyProcess expected, BaseRenderEndpoint selected) => BeginCore(expected, selected, holdPaused: false);

    // Product bootstrap only: apply while the source is confirmed paused. This is
    // policy ownership, not complete session proof and never playback readiness.
    // The host must verify paused state and retain Prepared ACK before mutation.
    public RouteRecord AcquirePaused(SpotifyProcess expected, BaseRenderEndpoint selected) => BeginCore(expected, selected, holdPaused: true);

    private RouteRecord BeginCore(SpotifyProcess expected, BaseRenderEndpoint selected, bool holdPaused)
    {
        lock (gate)
        {
            if (cancelRequested?.Invoke() == true) throw new OperationCanceledException("SUPERVISOR_CANCELLED");
            var previous = Load();
            if (previous is not null && previous.Stage is not (RouteStage.Restored or RouteStage.RolledBack))
                throw new RouteBlockedException("OPEN_TRANSACTION_REQUIRES_RECOVERY");
            using var bound = Bind(expected);
            CheckEndpoint(selected);
            // Read EVERY original before committing Prepared or issuing ANY setter.
            var roles = AllRoles.Select(role => new RouteRole(role, Read(bound, role), RoleStage.Untouched)).ToArray();
            Save(new RouteRecord(1, (previous?.Revision ?? 0) + 1, Guid.NewGuid(), expected,
                expected, selected, RouteStage.Prepared, roles, null, now()));
            try
            {
                foreach (var entry in current!.Roles.Where(x => IsAppliedRole(x.Role)))
                {
                    if (cancelRequested?.Invoke() == true) throw new OperationCanceledException("SUPERVISOR_CANCELLED");
                    CheckEndpoint(selected);
                    var present = Read(bound, entry.Role);
                    if (present != entry.Original) throw new RouteBlockedException("POLICY_CHANGED_BEFORE_APPLY");
                    if (entry.Original == selected.PolicyValue)
                    {
                        ChangeRole(entry.Role, RoleStage.PreexistingTarget, RouteStage.Applying);
                        continue; // This role belongs to its preexisting owner, never to us.
                    }
                    // Write-ahead intent covers death/throw after the native write but
                    // before its success return or the journal's Applied commit.
                    ChangeRole(entry.Role, RoleStage.ApplyIntent, RouteStage.Applying);
                    CheckBound(bound);
                    if (Read(bound, entry.Role) != entry.Original)
                        throw new RouteBlockedException("POLICY_CHANGED_BEFORE_APPLY");
                    if (cancelRequested?.Invoke() == true) throw new OperationCanceledException("SUPERVISOR_CANCELLED");
                    bound.Set(entry.Role, selected.PolicyValue);
                    if (Read(bound, entry.Role) != selected.PolicyValue)
                        throw new RouteBlockedException("APPLY_READBACK_MISMATCH");
                    ChangeRole(entry.Role, RoleStage.Applied, RouteStage.Applying);
                }
                CheckAppliedValues(bound);
                if (holdPaused) return ChangeStage(RouteStage.HeldPaused, null);
                ProveSession(bound);
                CheckAppliedValues(bound);
                return ChangeStage(RouteStage.Active, null);
            }
            catch (JournalUnavailableException) { throw; } // Durable intent remains; stop all further writes.
            catch (RouteBlockedException e) when (IsConflict(e.Message))
            { return ChangeStage(RouteStage.Conflict, e.Message); }
            catch (RouteBlockedException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
            { return ChangeStage(RouteStage.ReidentityRequired, e.Message); }
            catch (Exception e)
            {
                // A setter can throw after changing policy. Restore uses readback plus
                // persisted intent; it never assumes the throwing call had no effect.
                return RestoreBound(bound, rollback: true, issue: e.Message);
            }
        }
    }

    // Recheck the held route without demanding an active source. Called immediately
    // before permitting Folia-controlled source resume. No observer or setter runs.
    public RouteRecord ValidateHeldPaused() => ValidateHeld(activate: false);
    public RouteRecord ActivateHeld() => ValidateHeld(activate: true);
    private RouteRecord ValidateHeld(bool activate)
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage != RouteStage.HeldPaused) return record;
            try
            {
                if (cancelRequested?.Invoke() == true) throw new OperationCanceledException("SUPERVISOR_CANCELLED");
                using var bound = Bind(record.CurrentProcess);
                CheckEndpoint(record.Target);
                CheckAppliedValues(bound);
                if (!activate) return current!;
                ProveSession(bound);
                CheckAppliedValues(bound);
                return ChangeStage(RouteStage.Active, null);
            }
            catch (JournalUnavailableException) { throw; }
            catch (RouteBlockedException e) when (IsConflict(e.Message))
            { return ChangeStage(RouteStage.Conflict, e.Message); }
            catch (RouteBlockedException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
            { return ChangeStage(RouteStage.ReidentityRequired, e.Message); }
            catch (Exception e) { return ChangeStage(RouteStage.RecoveryRequired, e.Message); }
        }
    }

    // Source and capture quiescence must be independently proved by the service.
    // Re-enter held state without policy setters or an active-session observer.
    public RouteRecord HoldPaused()
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage is not (RouteStage.Active or RouteStage.HeldPaused)) return record;
            using var bound = Bind(record.CurrentProcess);
            CheckEndpoint(record.Target); CheckAppliedValues(bound);
            return record.Stage == RouteStage.HeldPaused ? record : ChangeStage(RouteStage.HeldPaused, null);
        }
    }

    public RouteRecord Restore()
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage is RouteStage.Restored or RouteStage.RolledBack) return record;
            try
            {
                using var bound = Bind(record.CurrentProcess);
                return RestoreBound(bound, rollback: false, issue: null);
            }
            catch (JournalUnavailableException) { throw; }
            catch (RouteBlockedException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
            { return ChangeStage(RouteStage.ReidentityRequired, e.Message); }
            catch (Exception e) { return ChangeStage(RouteStage.RecoveryRequired, e.Message); }
        }
    }

    // Crash/restart entry point. Fresh identity must be supplied by discovery and then
    // independently verified by the resolver. This never adopts a process by PID only.
    public RouteRecord RecoverAndRestore(SpotifyProcess freshlyDiscovered)
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage is RouteStage.Restored or RouteStage.RolledBack) return record;
            using var bound = Bind(freshlyDiscovered);
            if (!record.OriginalProcess.SameApplication(bound.Identity))
                throw new RouteBlockedException("RECOVERY_APPLICATION_IDENTITY_MISMATCH");
            Save(record with { Revision = record.Revision + 1, CurrentProcess = bound.Identity,
                UpdatedAtUtc = now() });
            return RestoreBound(bound, rollback: false, issue: "RECOVERY");
        }
    }

    // Read-only policy/session check; no reapply loop. Conflict or process restart
    // withdraws readiness. A normal host must stop capture when this is not Active.
    public RouteRecord ValidateActive()
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage != RouteStage.Active) return record;
            try
            {
                using var bound = Bind(record.CurrentProcess);
                CheckEndpoint(record.Target);
                CheckAppliedValues(bound);
                ProveSession(bound);
                CheckAppliedValues(bound);
                return current!;
            }
            catch (JournalUnavailableException) { throw; }
            catch (RouteBlockedException e) when (IsConflict(e.Message))
            { return ChangeStage(RouteStage.Conflict, e.Message); }
            catch (RouteBlockedException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
            { return ChangeStage(RouteStage.ReidentityRequired, e.Message); }
            catch (Exception e) { return ChangeStage(RouteStage.RecoveryRequired, e.Message); }
        }
    }

    private RouteRecord RestoreBound(IBoundSpotifyPolicy bound, bool rollback, string? issue)
    {
        try
        {
            // Preflight every possibly owned role before the first restore mutation.
            // On a conflict, leave all remaining policy untouched and preserve evidence.
            foreach (var role in current!.Roles.Where(MayOwn)) CheckRestorable(bound, role);
            ChangeStage(RouteStage.Restoring, issue);
            foreach (var role in current!.Roles.Reverse().Where(MayOwn).ToArray())
            {
                var present = CheckRestorable(bound, role);
                if (present == role.Original)
                {
                    ChangeRole(role.Role, RoleStage.Restored, RouteStage.Restoring);
                    continue;
                }
                ChangeRole(role.Role, RoleStage.RestoreIntent, RouteStage.Restoring);
                // Comparison is immediately before the setter, but the OS supplies no
                // CAS/ownership token; an external write can still race this check.
                present = CheckRestorable(bound, role);
                if (present != role.Original)
                {
                    bound.Set(role.Role, role.Original); // Null is deliberately preserved.
                    if (Read(bound, role.Role) != role.Original)
                        throw new RouteBlockedException("RESTORE_READBACK_MISMATCH");
                }
                ChangeRole(role.Role, RoleStage.Restored, RouteStage.Restoring);
            }
            return ChangeStage(rollback ? RouteStage.RolledBack : RouteStage.Restored, issue);
        }
        catch (JournalUnavailableException) { throw; }
        catch (RouteBlockedException e) when (IsConflict(e.Message))
        { return ChangeStage(RouteStage.Conflict, e.Message); }
        catch (RouteBlockedException e) when (e.Message == "SPOTIFY_INSTANCE_CHANGED")
        { return ChangeStage(RouteStage.ReidentityRequired, e.Message); }
        catch (Exception e) { return ChangeStage(RouteStage.RecoveryRequired, e.Message); }
    }

    private string? CheckRestorable(IBoundSpotifyPolicy bound, RouteRole role)
    {
        var present = Read(bound, role.Role);
        if (present != role.Original && present != current!.Target.PolicyValue)
            throw new RouteBlockedException("EXTERNAL_POLICY_CONFLICT");
        return present;
    }
    private void CheckAppliedValues(IBoundSpotifyPolicy bound)
    {
        foreach (var role in current!.Roles.Where(x => IsAppliedRole(x.Role)))
            if (Read(bound, role.Role) != current.Target.PolicyValue)
                throw new RouteBlockedException("EXTERNAL_POLICY_CONFLICT");
    }
    private void ProveSession(IBoundSpotifyPolicy bound)
    {
        var started = now();
        CheckBound(bound);
        var observation = observer.Observe(bound, SessionBudget);
        CheckBound(bound);
        if (!observation.CompleteForProcess || observation.Process != bound.Identity ||
            observation.ObservedAtUtc < started || observation.ObservedAtUtc > now())
            throw new RouteBlockedException("SESSION_OBSERVATION_UNTRUSTED");
        RequireTargetActivity(observation, bound.Identity, current!.Target.Id);
    }

    // Historical target activity is preparation evidence only. It never moves
    // the transaction to Active or grants permission to capture/publish PCM.
    public SessionObservation ObserveHeldTargetActivity(TimeSpan maximumWait)
    {
        lock (gate)
        {
            var record = RequireRecord();
            if (record.Stage != RouteStage.HeldPaused || maximumWait <= TimeSpan.Zero || maximumWait > SessionBudget)
                throw new RouteBlockedException("PREPARED_TARGET_ACTIVITY_INVALID_STATE");
            using var bound = Bind(record.CurrentProcess);
            CheckEndpoint(record.Target); CheckAppliedValues(bound);
            var started = now();
            var observation = observer.Observe(bound, maximumWait);
            CheckBound(bound); CheckEndpoint(record.Target); CheckAppliedValues(bound);
            if (!observation.CompleteForProcess || observation.Process != bound.Identity ||
                observation.ObservedAtUtc < started || observation.ObservedAtUtc > now())
                throw new RouteBlockedException("SESSION_OBSERVATION_UNTRUSTED");
            RequireTargetActivity(observation, bound.Identity, record.Target.Id);
            return observation;
        }
    }

    private static void RequireTargetActivity(SessionObservation observation, SpotifyProcess process, string target)
    {
        var active = observation.Sessions.Where(x => x.Active).ToArray();
        if (active.Length == 0 || active.Any(x => x.Process != process ||
            string.IsNullOrWhiteSpace(x.SessionInstanceId) || x.EndpointId != target))
            throw new RouteBlockedException("SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET");
    }
    private IBoundSpotifyPolicy Bind(SpotifyProcess expected)
    {
        if (!expected.WellFormed) throw new RouteBlockedException("SPOTIFY_IDENTITY_INCOMPLETE");
        var bound = resolver.OpenVerified(expected);
        try
        {
            if (bound.Identity != expected) throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
            CheckBound(bound);
            return bound;
        }
        catch { bound.Dispose(); throw; }
    }
    private static void CheckBound(IBoundSpotifyPolicy bound)
    {
        if (!bound.Identity.WellFormed || bound.CheckLiveIdentity() != bound.Identity)
            throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
    }
    private static string? Read(IBoundSpotifyPolicy bound, RenderRole role)
    {
        CheckBound(bound);
        var value = bound.Get(role);
        CheckBound(bound);
        // Empty string is not silently normalized into null/default. Adapter must audit
        // its exact Windows representation and preserve meaningful opaque identifiers.
        return value;
    }
    private void CheckEndpoint(BaseRenderEndpoint expected)
    {
        if (!expected.Eligible || endpointVerifier.VerifySelected(expected) != expected)
            throw new RouteBlockedException("SELECTED_BASE_RENDER_IDENTITY_INVALID");
    }
    private static bool MayOwn(RouteRole role) => role.Stage is
        RoleStage.ApplyIntent or RoleStage.Applied or RoleStage.RestoreIntent;
    // The bounded experiment changes only the historically exercised 0/1 roles.
    // Communications is captured as evidence but is outside our mutation surface.
    private static bool IsAppliedRole(RenderRole role) => role is RenderRole.Console or RenderRole.Multimedia;
    private static bool IsConflict(string message) => message is
        "POLICY_CHANGED_BEFORE_APPLY" or "EXTERNAL_POLICY_CONFLICT" or
        "APPLY_READBACK_MISMATCH" or "RESTORE_READBACK_MISMATCH";
    private RouteRecord ChangeRole(RenderRole role, RoleStage stage, RouteStage transactionStage) =>
        Save(current! with { Revision = current.Revision + 1, Stage = transactionStage,
            Roles = current.Roles.Select(x => x.Role == role ? x with { Stage = stage } : x).ToArray(),
            UpdatedAtUtc = now() });
    private RouteRecord ChangeStage(RouteStage stage, string? issue) =>
        Save(current! with { Revision = current.Revision + 1, Stage = stage, Issue = issue, UpdatedAtUtc = now() });
    private RouteRecord RequireRecord() => Load() ?? throw new RouteBlockedException("NO_TRANSACTION");
    private RouteRecord? Load()
    {
        current = journal.ReadLatest();
        if (current is not null) ValidateRecord(current);
        return current;
    }
    private RouteRecord Save(RouteRecord record)
    {
        ValidateRecord(record);
        try { journal.Append(record); }
        catch (Exception e) { throw new JournalUnavailableException("JOURNAL_COMMIT_FAILED_NO_MORE_POLICY_WRITES", e); }
        current = record;
        return record;
    }
    public static void ValidateRecord(RouteRecord r)
    {
        if (r.Schema != 1 || r.Revision < 1 || r.TransactionId == Guid.Empty ||
            !r.OriginalProcess.WellFormed || !r.CurrentProcess.WellFormed ||
            !r.OriginalProcess.SameApplication(r.CurrentProcess) || !r.Target.Eligible ||
            !Enum.IsDefined(r.Stage) || r.Roles.Length != AllRoles.Length ||
            !r.Roles.Select(x => x.Role).Order().SequenceEqual(AllRoles.Order()) ||
            r.Roles.Any(x => !Enum.IsDefined(x.Stage) ||
                (!IsAppliedRole(x.Role) && x.Stage != RoleStage.Untouched) ||
                (x.Stage == RoleStage.PreexistingTarget && x.Original != r.Target.PolicyValue) ||
                (MayOwn(x) && x.Original == r.Target.PolicyValue)) ||
            (r.Stage is RouteStage.Active or RouteStage.HeldPaused && r.Roles.Where(x => IsAppliedRole(x.Role)).Any(x => x.Stage is not (RoleStage.Applied or RoleStage.PreexistingTarget))) ||
            (r.Stage is RouteStage.Restored or RouteStage.RolledBack && r.Roles.Any(MayOwn)))
            throw new JournalUnavailableException("JOURNAL_SCHEMA_OR_IDENTITY_INVALID");
    }
}
