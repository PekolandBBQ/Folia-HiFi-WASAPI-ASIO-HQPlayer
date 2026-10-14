using System.Diagnostics;
using Folia.RouteResearch;
using Folia.RouteResearch.Windows;
using Folia.RouteObservation;
using Folia.RouteObservation.Windows;

namespace Folia.RouteRunner;

// Recover only a previous Folia transaction for the same verified application.
// Existing journals are appended, never replaced; unknown manual routes are not reset.
internal static class OrphanRouteRecovery
{
    internal static bool Eligible(RouteRecord record, SpotifyProcess process, bool oldProcessAlive) =>
        (!oldProcessAlive || record.CurrentProcess == process) && record.OriginalProcess.SameApplication(process)
        && record.Stage is not (RouteStage.Restored or RouteStage.RolledBack or RouteStage.Conflict)
        && record.Roles.Any(role => role.Stage is RoleStage.Applied or RoleStage.ApplyIntent or RoleStage.RestoreIntent);

    internal static bool Alive(SpotifyProcess identity)
    {
        try { using var process = Process.GetProcessById(identity.Pid); return process.StartTime.ToUniversalTime().Ticks == identity.StartTimeUtcTicks; }
        catch (ArgumentException) { return false; }
    }

    internal static object Run()
    {
        using var root = ProductJournalRootInitializer.Acquire();
        using var audio = new AudioReadOnly();
        var candidates = Process.GetProcessesByName("Spotify");
        try
        {
            foreach (var file in Directory.EnumerateFiles(root.Binding.PhysicalRoot, "*.jsonl").OrderByDescending(File.GetLastWriteTimeUtc))
            {
                if (!Guid.TryParse(Path.GetFileNameWithoutExtension(file), out _)) continue;
                // Selection is read-only. Do not open unrelated historical journals
                // for recovery (opening a torn journal may repair its final frame).
                RouteRecord? preview;
                try {
                    if (new FileInfo(file).Length > 16 * 1024 * 1024) continue;
                    var last = File.ReadLines(file).LastOrDefault(line => !string.IsNullOrWhiteSpace(line));
                    if (last is null) continue;
                    using var frame = System.Text.Json.JsonDocument.Parse(last);
                    preview = System.Text.Json.JsonSerializer.Deserialize<RouteRecord>(frame.RootElement.GetProperty("Payload").GetString()!);
                    if (preview is null || preview.Stage is RouteStage.Restored or RouteStage.RolledBack or RouteStage.Conflict) continue;
                    var matched = false;
                    foreach (var candidate in candidates) { using var identity = new SpotifyIdentity(candidate.Id); if (Eligible(preview, identity.Identity, Alive(preview.CurrentProcess))) { matched = true; break; } }
                    if (!matched) continue;
                } catch (IOException) { continue; }
                  catch (System.Text.Json.JsonException) { continue; }
                FileRouteJournal journal; JournalGuard guard;
                try {
                    guard = new JournalGuard(root, file, false);
                    try { journal = new FileRouteJournal(file, mustExist: true, validateHandle: guard.Validate); }
                    catch { guard.Dispose(); throw; }
                }
                catch (IOException) { continue; } // A live owner retains its exclusive journal.
                using (guard) using (journal)
                {
                    var record = journal.ReadLatest();
                    if (record is null || record.Stage is RouteStage.Restored or RouteStage.RolledBack or RouteStage.Conflict) continue;
                    foreach (var candidate in candidates)
                    {
                        using var identity = new SpotifyIdentity(candidate.Id);
                        // Spotify is the routed application, not the journal owner.
                        // The exclusive journal above excludes a live Folia owner;
                        // a surviving Spotify must match the exact retained process.
                        if (!Eligible(record, identity.Identity, Alive(record.CurrentProcess))) continue;
                        var resolver = new Win11SpotifyPolicyResolver(identity.Check);
                        using var bound = resolver.OpenVerified(identity.Identity);
                        string?[] present;
                        try { present = Enum.GetValues<RenderRole>().Select(bound.Get).ToArray(); }
                        catch (System.Runtime.InteropServices.COMException) { continue; } // Non-audio helper has no policy namespace.
                        if (!present.Take(2).Any(value => value == record.Target.PolicyValue)) continue;
                        _ = audio.VerifySelected(record.Target);
                        var originals = record.Roles.OrderBy(role => role.Role).Select(role => role.Original).ToArray();
                        _ = OriginalPolicySafety.Verify(originals, record.Target, ProductDefaultEndpoints.Read(), audio.Endpoints(), audio.EndpointForPolicy, PhysicalOriginalEndpointProbe.Read,
                            allowDefaultFollow: true);
                        using var observer = new ProductSessionObserver(new WindowsCoreAudioSessionFeed(TimeSpan.FromSeconds(2)), record.Target.Id);
                        observer.BindAudioProcessSet(candidates.Select(value => value.Id));
                        var observation = observer.ForPause.Observe(bound, TimeSpan.FromSeconds(3));
                        if (!observation.CompleteForProcess || observation.Sessions.Length == 0 || observation.Sessions.Any(row => row.Active))
                            throw new RouteBlockedException("ORPHAN_ROUTE_SOURCE_NOT_PAUSED");
                        // Recheck the same native pause immediately before each restoration write.
                        var guarded = new Win11SpotifyPolicyResolver(identity.Check, beforeSet: () => {
                            root.Validate();
                            var fresh = observer.ForPause.Observe(bound, TimeSpan.FromSeconds(2));
                            if (!fresh.CompleteForProcess || fresh.Sessions.Any(row => row.Active)) throw new RouteBlockedException("ORPHAN_ROUTE_SOURCE_NOT_PAUSED");
                        });
                        var transaction = new OwnedRouteTransaction(guarded, audio, observer.ForPause, journal);
                        var result = transaction.RecoverAndRestore(identity.Identity);
                        if (result.Stage != RouteStage.Restored) throw new RouteBlockedException(result.Issue ?? "ORPHAN_ROUTE_RESTORE_UNCONFIRMED");
                        return new { restored = true, code = "ORPHAN_ROUTE_RESTORED", globalDefaultsWritten = false };
                    }
                }
            }
            throw new RouteBlockedException("ORPHAN_ROUTE_RECORD_NOT_FOUND");
        }
        finally { foreach (var candidate in candidates) candidate.Dispose(); }
    }
}
