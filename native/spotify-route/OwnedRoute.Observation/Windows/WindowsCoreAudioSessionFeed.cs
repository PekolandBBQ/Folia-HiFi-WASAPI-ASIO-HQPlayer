using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using static Folia.RouteObservation.Windows.CoreAudioReadOnlyInterop;

namespace Folia.RouteObservation.Windows;

/// <summary>
/// Read-only Core Audio inventory on a dedicated MTA thread. This is an
/// implementation candidate, not evidence of Windows/hardware qualification.
/// A fault or canceled in-flight call poisons this instance; create a new feed.
/// </summary>
/// <remarks>
/// Notification delegates execute synchronously at callback entry so an observer
/// can invalidate a proof before queued work runs. They MUST be nonblocking,
/// must not call the feed, and should use only Volatile/Interlocked operations.
/// All COM registration, unregistration and owned final releases run on the MTA
/// worker. Caller waits and Dispose are bounded even if a COM call is stalled.
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class WindowsCoreAudioSessionFeed : IReadOnlySessionFeed, IReadOnlySessionIsolationFeed
{
    private const int MaximumEndpoints = 128;
    private const int MaximumSessionsPerEndpoint = 4096;
    private const int FailureHResult = unchecked((int)0x80004005);
    private readonly TimeSpan operationTimeout;
    private readonly int maximumQueuedNotifications;
    private readonly Thread worker;
    private readonly AutoResetEvent wake = new(false);
    private readonly ConcurrentQueue<IWork> work = new();
    private readonly CallbackPublicationQueue<PendingSession> publications;
    private readonly TaskCompletionSource<bool> started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<EndpointState> endpoints = new(); // MTA-owned.
    private TopologySubscription[] topologySubscriptions = [];
    private EndpointState[] publishedEndpoints = [];
    private EndpointNotificationSink? endpointSink;
    private IntPtr enumerator;
    private IntPtr endpointSinkPointer;
    private bool endpointNotificationsRegistered;
    private int stopping;
    private int poisoned;
    private int queuedWork;
    private string? failureReason;
    private string? propertyDiagnostic;
    private readonly SessionIsolationLedger isolation = new();
    public void BindOwnedSilentRenderSession(OwnedSilentRenderSession identity) => isolation.BindOwnedSilentRenderSession(identity);
    public bool IsStopped => Volatile.Read(ref stopping) != 0 && !worker.IsAlive;
    public bool IntervalIsolated
    {
        get
        {
            var result = isolation.Isolated && IsPublicationQuiescent && isolation.Isolated;
            var propertyChange = Interlocked.Exchange(ref propertyDiagnostic, null);
            // Optional local diagnosis only; never use this later snapshot to
            // promote the failed interval check or clear sticky history.
            if (!result || propertyChange is not null)
            {
                var path = Environment.GetEnvironmentVariable("FOLIA_COLD_TIMING_LOG");
                if (!string.IsNullOrWhiteSpace(path))
                    try { File.AppendAllText(path, System.Text.Json.JsonSerializer.Serialize(new {
                        at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), pid = Environment.ProcessId,
                        stage = result ? "route.interval-property-rechecked" : "route.interval-unconfirmed", reason = isolation.DiagnosticReason,
                        propertyChange,
                        publicationIdle = publications.IsIdle, pendingPublications = publications.PendingCount,
                        poisoned = Volatile.Read(ref poisoned) != 0, stopping = Volatile.Read(ref stopping) != 0,
                        failureReason = Volatile.Read(ref failureReason)
                    }) + Environment.NewLine); } catch { }
            }
            return result;
        }
    }
    public void BeginIsolation(string renderEndpointId, uint verifiedOwnerPid, CancellationToken cancellationToken) => Invoke(() =>
    {
        var endpoint = endpoints.SingleOrDefault(value => value.EndpointId == renderEndpointId && Volatile.Read(ref value.Closed) == 0)
            ?? throw new InvalidOperationException("INTERVAL_ENDPOINT_NOT_RETAINED");
        var rows = endpoint.Sessions.Values.Select(value => Volatile.Read(ref value.IdentitySnapshot)
            ?? throw new InvalidOperationException("INTERVAL_BASELINE_IDENTITY_UNKNOWN")).ToArray();
        isolation.Arm(renderEndpointId, verifiedOwnerPid, rows);
        return true;
    }, cancellationToken);
    public bool IsPublicationQuiescent => publications.IsIdle && publications.PendingCount == 0 &&
        Volatile.Read(ref poisoned) == 0 && Volatile.Read(ref stopping) == 0;

    public WindowsCoreAudioSessionFeed(TimeSpan? operationTimeout = null,
        int maximumQueuedNotifications = 4096)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Core Audio observation requires Windows.");
        this.operationTimeout = operationTimeout ?? TimeSpan.FromSeconds(5);
        if (this.operationTimeout <= TimeSpan.Zero || this.operationTimeout > TimeSpan.FromMinutes(1))
            throw new ArgumentOutOfRangeException(nameof(operationTimeout));
        if (maximumQueuedNotifications is < 1 or > 65536)
            throw new ArgumentOutOfRangeException(nameof(maximumQueuedNotifications));
        this.maximumQueuedNotifications = maximumQueuedNotifications;
        publications = new(maximumQueuedNotifications);
        worker = new Thread(WorkerMain) { IsBackground = true, Name = "Folia read-only Core Audio observer" };
        worker.Start();
        try { started.Task.WaitAsync(this.operationTimeout).GetAwaiter().GetResult(); }
        catch
        {
            Dispose();
            throw;
        }
    }

    public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> changed,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(changed);
        return Invoke(() =>
        {
            var subscription = new TopologySubscription(this, changed);
            Volatile.Write(ref topologySubscriptions, [.. topologySubscriptions, subscription]);
            if (!endpointNotificationsRegistered)
            {
                endpointSink = new EndpointNotificationSink(this);
                endpointSinkPointer = Marshal.GetComInterfaceForObject(endpointSink,
                    typeof(IReadOnlyEndpointNotificationCallback));
                Check(Slot<NotificationRegistration>(enumerator, 6)(enumerator, endpointSinkPointer));
                endpointNotificationsRegistered = true;
            }
            return (IDisposable)subscription;
        }, cancellationToken);
    }

    public string[] EnumerateActiveRenderEndpoints(CancellationToken cancellationToken) => Invoke(() =>
    {
        IntPtr collection = IntPtr.Zero;
        try
        {
            Check(Slot<EnumerateDevices>(enumerator, 3)(enumerator, 0, 1, out collection));
            Check(Slot<GetUInt32>(collection, 3)(collection, out var count));
            if (count > MaximumEndpoints) throw new InvalidDataException("CORE_AUDIO_ENDPOINT_LIMIT");
            var result = new List<string>(checked((int)count));
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (uint index = 0; index < count; index++)
            {
                EnsureHealthy();
                IntPtr endpoint = IntPtr.Zero;
                try
                {
                    Check(Slot<DeviceItem>(collection, 4)(collection, index, out endpoint));
                    var id = OwnedString(endpoint, 5);
                    if (!unique.Add(id)) throw new InvalidDataException("CORE_AUDIO_DUPLICATE_ENDPOINT_ID");
                    result.Add(id);
                }
                finally { Release(ref endpoint); }
            }
            return result.ToArray();
        }
        finally { Release(ref collection); }
    }, cancellationToken);

    public IEndpointSessionFeed OpenEndpoint(string endpointId, Action<SessionFeedEvent> changed,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(endpointId);
        ArgumentNullException.ThrowIfNull(changed);
        return Invoke(() =>
        {
            // Adding an unrelated DAC after backend handoff leaves Base covered.
            // Re-registering Base itself still invalidates its armed interval.
            isolation.PropertiesChanged(endpointId, "endpoint-registration");
            var state = new EndpointState(this, endpointId, changed);
            endpoints.Add(state);
            Volatile.Write(ref publishedEndpoints, endpoints.ToArray());
            IntPtr endpoint = IntPtr.Zero;
            try
            {
                Check(Slot<GetDevice>(enumerator, 5)(enumerator, endpointId, out endpoint));
                if (!StringComparer.Ordinal.Equals(OwnedString(endpoint, 5), endpointId))
                    throw new InvalidDataException("CORE_AUDIO_ENDPOINT_ID_CHANGED");
                Check(Slot<GetUInt32>(endpoint, 6)(endpoint, out var deviceState));
                if (deviceState != 1) throw new InvalidDataException("CORE_AUDIO_ENDPOINT_NOT_ACTIVE");
                Check(Slot<Activate>(endpoint, 3)(endpoint, in SessionManagerInterface,
                    23, IntPtr.Zero, out state.Manager));
                state.CreationSink = new SessionCreatedSink(state);
                state.CreationSinkPointer = Marshal.GetComInterfaceForObject(state.CreationSink,
                    typeof(IReadOnlySessionCreatedCallback));
                Check(Slot<NotificationRegistration>(state.Manager, 6)(state.Manager, state.CreationSinkPointer));
                state.CreationRegistered = true;
                // ReadSessions performs GetSessionEnumerator/GetCount only after
                // the manager registration above. The observer opens ALL endpoint
                // managers before its first read, closing the bootstrap race.
                return (IEndpointSessionFeed)new EndpointFeed(state);
            }
            catch
            {
                Poison("CORE_AUDIO_OPEN_ENDPOINT_FAILED");
                DisposeEndpoint(state);
                throw;
            }
            finally { Release(ref endpoint); }
        }, cancellationToken);
    }

    private RawAudioSession[] ReadSessions(EndpointState endpoint)
    {
        if (Volatile.Read(ref endpoint.Closed) != 0)
            throw new ObjectDisposedException(nameof(IEndpointSessionFeed));
        IntPtr sessionEnumerator = IntPtr.Zero;
        try
        {
            Check(Slot<GetPointer>(endpoint.Manager, 5)(endpoint.Manager, out sessionEnumerator));
            // Required by RegisterSessionNotification: this activates delivery of
            // creation events. It must never precede the manager registration.
            Check(Slot<GetInt32>(sessionEnumerator, 3)(sessionEnumerator, out var count));
            if (count is < 0 or > MaximumSessionsPerEndpoint)
                throw new InvalidDataException("CORE_AUDIO_SESSION_LIMIT");
            for (var index = 0; index < count; index++)
            {
                EnsureHealthy();
                IntPtr session = IntPtr.Zero;
                try
                {
                    Check(Slot<SessionItem>(sessionEnumerator, 4)(sessionEnumerator, index, out session));
                    RetainSession(endpoint, session);
                }
                finally { Release(ref session); }
            }
        }
        finally { Release(ref sessionEnumerator); }

        // Enumeration is never used to prune the dictionary. Notification-only
        // controls remain strongly held and participate in every subsequent read.
        DrainNotifications();
        var result = new List<RawAudioSession>();
        foreach (var entry in endpoint.Sessions.Values.ToArray())
        {
            EnsureHealthy();
            if (Volatile.Read(ref entry.Invalidated) != 0) continue;
            var exactId = OwnedString(entry.Control, 13);
            if (!StringComparer.Ordinal.Equals(exactId, entry.InstanceId))
                throw new InvalidDataException("CORE_AUDIO_SESSION_ID_CHANGED");
            Check(Slot<GetInt32>(entry.Control, 3)(entry.Control, out var state));
            if (state is < 0 or > 2) throw new InvalidDataException("CORE_AUDIO_SESSION_STATE_INVALID");
            var pidResult = Slot<GetUInt32>(entry.Control, 14)(entry.Control, out var processId);
            var systemSoundsResult = Slot<HResultOnly>(entry.Control, 15)(entry.Control);
            var groupingResult = Slot<GetGuid>(entry.Control, 8)(entry.Control, out var grouping);
            // Keep native results verbatim, including AUDCLNT_S_NO_SINGLE_PROCESS.
            // Failed identity getters invalidate the feed as well as retaining the
            // exact HRESULT locally; no caller can promote that row to a proof.
            var row = new RawAudioSession(exactId, endpoint.EndpointId,
                (AudioSessionState)state, processId, pidResult, systemSoundsResult, grouping, groupingResult);
            if (pidResult < 0 || systemSoundsResult < 0)
            {
                Poison("CORE_AUDIO_SESSION_IDENTITY_API_FAILED");
                throw new COMException("Core Audio identity getter failed.",
                    pidResult < 0 ? pidResult : systemSoundsResult);
            }
            RecordIdentity(entry, row, created: false);
            if (state == (int)AudioSessionState.Expired)
            {
                Volatile.Write(ref entry.Invalidated, 1);
                continue;
            }
            if (Volatile.Read(ref entry.Invalidated) == 0) result.Add(row);
        }
        DrainNotifications();
        return result.ToArray();
    }

    private void RetainSession(EndpointState endpoint, IntPtr session)
    {
        if (Volatile.Read(ref endpoint.Closed) != 0) return;
        IntPtr control = IntPtr.Zero;
        SessionEntry? entry = null;
        var intervalPending = isolation.BeginPending(endpoint.EndpointId);
        try
        {
            var iid = SessionControl2Interface;
            Check(Marshal.QueryInterface(session, ref iid, out control));
            entry = new SessionEntry(endpoint, control);
            control = IntPtr.Zero; // entry owns the QueryInterface reference.
            entry.Sink = new SessionEventsSink(entry);
            entry.SinkPointer = Marshal.GetComInterfaceForObject(entry.Sink,
                typeof(IReadOnlySessionEventsCallback));
            Check(Slot<NotificationRegistration>(entry.Control, 10)(entry.Control, entry.SinkPointer));
            entry.Registered = true;
            // Register before reading even the first identity field, so a state
            // change during identification cannot escape invalidation.
            entry.InstanceId = OwnedString(entry.Control, 13);
            // Read ownership before any expired/disconnected control can retire.
            // Even an already-inactive foreign creation contaminates this interval:
            // it may have emitted the entire burst before this MTA dequeued it.
            Check(Slot<GetInt32>(entry.Control, 3)(entry.Control, out var state));
            if (state is < 0 or > 2) throw new InvalidDataException("CORE_AUDIO_SESSION_STATE_INVALID");
            var pidResult = Slot<GetUInt32>(entry.Control, 14)(entry.Control, out var pid);
            var systemResult = Slot<HResultOnly>(entry.Control, 15)(entry.Control);
            var groupingResult = Slot<GetGuid>(entry.Control, 8)(entry.Control, out var grouping);
            if (pidResult < 0 || systemResult < 0) throw new COMException("Core Audio identity unavailable before retention.", pidResult < 0 ? pidResult : systemResult);
            var alreadyRetained = endpoint.Sessions.ContainsKey(entry.InstanceId);
            RecordIdentity(entry, new(entry.InstanceId, endpoint.EndpointId, (AudioSessionState)state, pid, pidResult, systemResult, grouping, groupingResult),
                !alreadyRetained);
            // A delayed creation notification for an exact instance already in
            // the pre-arm baseline is not a new interval creation. Its retained
            // original event sink still records all subsequent state changes.
            if (alreadyRetained)
            {
                var previous = Volatile.Read(ref endpoint.Sessions[entry.InstanceId].IdentitySnapshot);
                if (previous is null || previous.ReportedProcessId != pid || previous.ProcessIdHResult != pidResult || previous.SystemSoundsHResult != systemResult)
                {
                    isolation.Discontinuity("session-identity-collision");
                    throw new InvalidDataException("CORE_AUDIO_SESSION_INSTANCE_IDENTITY_COLLISION");
                }
                return;
            }
            if (endpoint.Sessions.Count >= MaximumSessionsPerEndpoint)
                throw new InvalidDataException("CORE_AUDIO_RETAINED_SESSION_LIMIT");
            endpoint.Sessions.Add(entry.InstanceId, entry);
            entry = null;
        }
        finally
        {
            if (entry is not null) DisposeSession(entry);
            Release(ref control);
            if (intervalPending) isolation.EndPending();
        }
    }

    private void RecordIdentity(SessionEntry entry, RawAudioSession row, bool created)
    {
        var prior = Volatile.Read(ref entry.IdentitySnapshot);
        if (prior is not null && (prior.ReportedProcessId != row.ReportedProcessId || prior.ProcessIdHResult != row.ProcessIdHResult || prior.SystemSoundsHResult != row.SystemSoundsHResult))
            isolation.Discontinuity("session-identity-changed");
        Volatile.Write(ref entry.IdentitySnapshot, row);
        if (created) isolation.ObserveCreated(row); else isolation.ObserveExisting(row);
        if (Volatile.Read(ref entry.ChangedBeforeIdentity) != 0) isolation.ObserveEvent(entry.Endpoint.EndpointId, row);
    }

    private void DrainNotifications()
    {
        var startedWaiting = Stopwatch.GetTimestamp();
        do
        {
            // A callback may already have invalidated the observer while still
            // holding an unpublished notification-only session. An empty queue
            // alone is not a publication fence. Wait off the native callback.
            publications.WaitUntilIdle(operationTimeout - Stopwatch.GetElapsedTime(startedWaiting), EnsureHealthy);
            while (publications.TryTake(out var pending))
            {
                var pointer = pending.Session;
                try
                {
                    if (Volatile.Read(ref stopping) == 0 && Volatile.Read(ref poisoned) == 0 &&
                        Volatile.Read(ref pending.Endpoint.Closed) == 0)
                        RetainSession(pending.Endpoint, pointer);
                }
                catch { Poison("CORE_AUDIO_NOTIFICATION_PROCESSING_FAILED"); }
                finally
                {
                    Release(ref pointer);
                    if (pending.IntervalPending) isolation.EndPending();
                }
            }
        }
        while (!publications.IsIdle || publications.PendingCount != 0);
        foreach (var endpoint in endpoints)
        {
            foreach (var entry in endpoint.Sessions.Values.ToArray())
            {
                if (Volatile.Read(ref entry.Invalidated) == 0) continue;
                endpoint.Sessions.Remove(entry.InstanceId!);
                DisposeSession(entry);
            }
        }
    }

    // Called from native callbacks: invalidation is synchronous and nonblocking;
    // native getters and all registrations/final releases remain on the worker.
    internal int SessionCreated(EndpointState endpoint, IntPtr newSession)
    {
        if (!publications.TryEnter()) return 0;
        IntPtr owned = IntPtr.Zero;
        try
        {
            if (Volatile.Read(ref stopping) != 0 || Volatile.Read(ref endpoint.Closed) != 0) return 0;
            if (!Notify(endpoint.Changed, new(SessionFeedEventKind.SessionChanged, endpoint.EndpointId)))
                return FailureHResult;
            if (Volatile.Read(ref poisoned) != 0) return FailureHResult;
            if (newSession == IntPtr.Zero) throw new InvalidDataException("CORE_AUDIO_NULL_CREATED_SESSION");
            var pending = new PendingSession(endpoint, newSession, isolation.BeginPending(endpoint.EndpointId));
            Marshal.AddRef(newSession); // Borrowed callback pointer becomes owned.
            owned = newSession;
            if (!publications.TryPublish(pending))
            {
                if (pending.IntervalPending) isolation.EndPending();
                throw new InvalidOperationException("CORE_AUDIO_NOTIFICATION_QUEUE_FULL");
            }
            owned = IntPtr.Zero; // Queue now owns the extra reference.
            // Close the gap between initial invalidation and pointer publication.
            // Reads additionally refuse to pass the in-flight publication fence.
            if (!Notify(endpoint.Changed, new(SessionFeedEventKind.SessionChanged, endpoint.EndpointId)))
                return FailureHResult;
            SignalWorker();
            return 0;
        }
        catch
        {
            // If enqueue failed, release only our EXTRA AddRef. The native caller
            // still owns the borrowed callback argument, so this cannot be the
            // final reference on the WASAPI object during the callback.
            if (owned != IntPtr.Zero) Marshal.Release(owned);
            Poison("CORE_AUDIO_CREATION_CALLBACK_FAILED");
            return FailureHResult;
        }
        finally { publications.Exit(); SignalWorker(); }
    }

    internal int SessionChanged(SessionEntry entry, bool invalidate, int? state = null, bool groupingChanged = false)
    {
        if (!publications.TryEnter()) return 0;
        try
        {
            if (Volatile.Read(ref stopping) != 0 || Volatile.Read(ref entry.Endpoint.Closed) != 0) return 0;
            if (invalidate) Volatile.Write(ref entry.Invalidated, 1);
            var identity = Volatile.Read(ref entry.IdentitySnapshot);
            if (identity is null) Volatile.Write(ref entry.ChangedBeforeIdentity, 1);
            else
            {
                if (state is { } next) identity = identity with { State = (AudioSessionState)next };
                if (invalidate) identity = identity with { State = AudioSessionState.Expired };
                if (groupingChanged) identity = identity with { GroupingHResult = null };
                isolation.ObserveEvent(entry.Endpoint.EndpointId, identity);
            }
            if (!Notify(entry.Endpoint.Changed, new(SessionFeedEventKind.SessionChanged,
                    entry.Endpoint.EndpointId, Volatile.Read(ref entry.InstanceId)))) return FailureHResult;
            SignalWorker();
            return 0;
        }
        catch { Poison("CORE_AUDIO_SESSION_CALLBACK_FAILED"); return FailureHResult; }
        finally { publications.Exit(); SignalWorker(); }
    }

    internal int PropertiesChanged(string? endpoint, ReadOnlyPropertyKey key)
    {
        if (!publications.TryEnter()) return 0;
        try
        {
            if (Volatile.Read(ref stopping) != 0) return 0;
            var reason = $"device-property:{key.FormatId:D}:{key.PropertyId}";
            var affectsCapture = isolation.PropertiesChanged(endpoint, reason);
            Volatile.Write(ref propertyDiagnostic, $"{reason}:capture={affectsCapture}");
            foreach (var subscription in Volatile.Read(ref topologySubscriptions))
                if (Volatile.Read(ref subscription.Closed) == 0 &&
                    !Notify(subscription.Changed, new(SessionFeedEventKind.EndpointPropertyChanged, endpoint)))
                    return FailureHResult;
            return 0;
        }
        catch { Poison("CORE_AUDIO_PROPERTY_CALLBACK_FAILED"); return FailureHResult; }
        finally { publications.Exit(); SignalWorker(); }
    }

    internal int TopologyChanged(string reason = "device-topology", string? endpoint = null)
    {
        if (!publications.TryEnter()) return 0;
        try
        {
            if (Volatile.Read(ref stopping) != 0) return 0;
            var affectsCapture = isolation.PropertiesChanged(endpoint, reason);
            foreach (var subscription in Volatile.Read(ref topologySubscriptions))
            {
                if (Volatile.Read(ref subscription.Closed) == 0 &&
                    !Notify(subscription.Changed, new(affectsCapture ? SessionFeedEventKind.EndpointTopologyChanged
                        : SessionFeedEventKind.EndpointInventoryChanged, endpoint)))
                    return FailureHResult;
            }
            return 0;
        }
        catch { Poison("CORE_AUDIO_TOPOLOGY_CALLBACK_FAILED"); return FailureHResult; }
        finally { publications.Exit(); SignalWorker(); }
    }

    internal int DefaultsChanged()
    {
        if (!publications.TryEnter()) return 0;
        try
        {
            if (Volatile.Read(ref stopping) != 0) return 0;
            // Default resolution can legitimately change under exclusive output.
            // Registrations stay retained; product rechecks the non-Base feedback
            // guard and every actual writer event still enters the sticky ledger.
            foreach (var subscription in Volatile.Read(ref topologySubscriptions))
                if (Volatile.Read(ref subscription.Closed) == 0 &&
                    !Notify(subscription.Changed, new(SessionFeedEventKind.DefaultChanged))) return FailureHResult;
            return 0;
        }
        catch { Poison("CORE_AUDIO_DEFAULT_CALLBACK_FAILED"); return FailureHResult; }
        finally { publications.Exit(); SignalWorker(); }
    }

    private bool Notify(Action<SessionFeedEvent> changed, SessionFeedEvent value)
    {
        try { changed(value); return true; }
        catch { Poison("CORE_AUDIO_OBSERVER_CALLBACK_FAILED"); return false; }
    }

    private void Poison(string reason)
    {
        isolation.Discontinuity("feed-poisoned");
        if (Interlocked.CompareExchange(ref poisoned, 1, 0) != 0) return;
        Volatile.Write(ref failureReason, reason);
        var value = new SessionFeedEvent(SessionFeedEventKind.EventLoss);
        foreach (var subscription in Volatile.Read(ref topologySubscriptions))
        {
            if (Volatile.Read(ref subscription.Closed) != 0) continue;
            try { subscription.Changed(value); } catch { /* Poison is permanent. */ }
        }
        foreach (var endpoint in Volatile.Read(ref publishedEndpoints))
        {
            if (Volatile.Read(ref endpoint.Closed) != 0) continue;
            try { endpoint.Changed(value with { EndpointId = endpoint.EndpointId }); }
            catch { /* All future reads still fail closed. */ }
        }
    }

    private void EnsureHealthy()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref stopping) != 0, this);
        if (Volatile.Read(ref poisoned) != 0)
            throw new InvalidOperationException(Volatile.Read(ref failureReason) ?? "CORE_AUDIO_FEED_POISONED");
    }

    private T Invoke<T>(Func<T> body, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EnsureHealthy();
        if (Thread.CurrentThread == worker)
            throw new InvalidOperationException("CORE_AUDIO_CALLBACK_REENTRANCY_FORBIDDEN");
        var item = new Work<T>(body, false);
        Enqueue(item);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(operationTimeout);
        try
        {
            var result = item.Completion.Task.WaitAsync(deadline.Token).GetAwaiter().GetResult();
            deadline.Token.ThrowIfCancellationRequested();
            EnsureHealthy();
            return result;
        }
        catch (OperationCanceledException)
        {
            item.Cancel();
            Poison("CORE_AUDIO_OPERATION_CANCELED_OR_TIMED_OUT");
            throw;
        }
    }

    private void Enqueue(IWork item)
    {
        if (Interlocked.Increment(ref queuedWork) > maximumQueuedNotifications)
        {
            Interlocked.Decrement(ref queuedWork);
            Poison("CORE_AUDIO_WORK_QUEUE_FULL");
            throw new InvalidOperationException("CORE_AUDIO_WORK_QUEUE_FULL");
        }
        try { work.Enqueue(item); }
        catch
        {
            Interlocked.Decrement(ref queuedWork);
            Poison("CORE_AUDIO_WORK_QUEUE_FAILED");
            throw;
        }
        SignalWorker();
    }

    private void SignalWorker()
    {
        try { wake.Set(); }
        catch (ObjectDisposedException)
        {
            if (Volatile.Read(ref stopping) == 0) Poison("CORE_AUDIO_WORK_SIGNAL_FAILED");
        }
    }

    private void WorkerMain()
    {
        var comInitialized = false;
        try
        {
            Check(CoInitializeEx(IntPtr.Zero, 0)); // COINIT_MULTITHREADED.
            comInitialized = true;
            Check(CoCreateInstance(in EnumeratorClass, IntPtr.Zero, 1, in EnumeratorInterface, out enumerator));
            started.TrySetResult(true);
            while (Volatile.Read(ref stopping) == 0)
            {
                try { DrainNotifications(); }
                catch { Poison("CORE_AUDIO_NOTIFICATION_PROCESSING_FAILED"); }
                if (work.TryDequeue(out var item))
                {
                    Interlocked.Decrement(ref queuedWork);
                    item.Run(this);
                }
                else wake.WaitOne();
            }
        }
        catch (Exception error)
        {
            Poison("CORE_AUDIO_MTA_WORKER_FAILED");
            started.TrySetException(error);
        }
        finally
        {
            Interlocked.Exchange(ref stopping, 1);
            publications.Close();
            foreach (var endpoint in endpoints.ToArray()) DisposeEndpoint(endpoint);
            DisposeEndpointRegistration();
            // An already-entered creation callback may have passed its stopping
            // check before teardown. Wait here (never in a callback) before the
            // final drain so its AddRef cannot be stranded after worker exit.
            var spin = new SpinWait();
            while (!publications.IsIdle) spin.SpinOnce();
            while (publications.TryTake(out var pending))
            {
                var pointer = pending.Session;
                try { Release(ref pointer); } catch { Poison("CORE_AUDIO_RELEASE_FAILED"); }
                finally { if (pending.IntervalPending) isolation.EndPending(); }
            }
            while (work.TryDequeue(out var item)) item.Abort();
            try { Release(ref enumerator); } catch { Poison("CORE_AUDIO_RELEASE_FAILED"); }
            if (comInitialized) CoUninitialize();
            wake.Dispose();
        }
    }

    private void DisposeSession(SessionEntry entry)
    {
        Volatile.Write(ref entry.Invalidated, 1);
        try
        {
            if (entry.Registered)
                Check(Slot<NotificationRegistration>(entry.Control, 11)(entry.Control, entry.SinkPointer));
        }
        catch { Poison("CORE_AUDIO_SESSION_UNREGISTER_FAILED"); }
        finally
        {
            entry.Registered = false;
            Release(ref entry.SinkPointer);
            Release(ref entry.Control);
            GC.KeepAlive(entry.Sink);
            entry.Sink = null;
        }
    }

    private void DisposeEndpoint(EndpointState endpoint)
    {
        isolation.PropertiesChanged(endpoint.EndpointId, "endpoint-disposed");
        if (Interlocked.Exchange(ref endpoint.Closed, 1) != 0) return;
        foreach (var entry in endpoint.Sessions.Values) DisposeSession(entry);
        endpoint.Sessions.Clear();
        try
        {
            if (endpoint.CreationRegistered)
                Check(Slot<NotificationRegistration>(endpoint.Manager, 7)(endpoint.Manager, endpoint.CreationSinkPointer));
        }
        catch { Poison("CORE_AUDIO_MANAGER_UNREGISTER_FAILED"); }
        finally
        {
            endpoint.CreationRegistered = false;
            Release(ref endpoint.CreationSinkPointer);
            Release(ref endpoint.Manager);
            GC.KeepAlive(endpoint.CreationSink);
            endpoint.CreationSink = null;
            endpoints.Remove(endpoint);
            Volatile.Write(ref publishedEndpoints, endpoints.ToArray());
        }
    }

    private void DisposeEndpointRegistration()
    {
        isolation.Discontinuity("endpoint-registration-disposed");
        try
        {
            if (endpointNotificationsRegistered)
                Check(Slot<NotificationRegistration>(enumerator, 7)(enumerator, endpointSinkPointer));
        }
        catch { Poison("CORE_AUDIO_ENDPOINT_UNREGISTER_FAILED"); }
        finally
        {
            endpointNotificationsRegistered = false;
            Release(ref endpointSinkPointer);
            GC.KeepAlive(endpointSink);
            endpointSink = null;
        }
    }

    private void DisposeSubscription(TopologySubscription subscription)
    {
        Volatile.Write(ref subscription.Closed, 1);
        Volatile.Write(ref topologySubscriptions, topologySubscriptions.Where(x => x != subscription).ToArray());
        if (topologySubscriptions.Length == 0) DisposeEndpointRegistration();
    }

    private void ScheduleCleanup(Action action)
    {
        if (Thread.CurrentThread == worker) { action(); return; }
        if (Volatile.Read(ref stopping) != 0) return; // Worker finalizer owns cleanup.
        var item = new Work<bool>(() => { action(); return true; }, true);
        try
        {
            Enqueue(item);
            // Cleanup is ordered before subsequent worker operations, but must
            // not charge a separate blocking timeout for every endpoint while
            // an observer is resetting its bounded observation epoch.
        }
        catch { Poison("CORE_AUDIO_DISPOSE_DELAYED_OR_FAILED"); }
    }

    public void Dispose()
    {
        publications.Close();
        Interlocked.Exchange(ref stopping, 1);
        SignalWorker();
        if (Thread.CurrentThread != worker) worker.Join(TimeSpan.FromSeconds(2));
        // If native code stalled, the background worker retains all references
        // and completes teardown when it resumes. Never free COM on this thread.
    }

    private interface IWork
    {
        void Run(WindowsCoreAudioSessionFeed owner);
        void Abort();
    }

    private sealed class Work<T>(Func<T> body, bool cleanup) : IWork
    {
        internal readonly TaskCompletionSource<T> Completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int canceled;
        internal void Cancel() { Interlocked.Exchange(ref canceled, 1); Completion.TrySetCanceled(); }
        public void Run(WindowsCoreAudioSessionFeed owner)
        {
            if (Volatile.Read(ref canceled) != 0) return;
            try
            {
                if (!cleanup) { owner.DrainNotifications(); owner.EnsureHealthy(); }
                var result = body();
                if (!cleanup) { owner.DrainNotifications(); owner.EnsureHealthy(); }
                if (Volatile.Read(ref canceled) == 0) Completion.TrySetResult(result);
            }
            catch (Exception error)
            {
                owner.Poison("CORE_AUDIO_OPERATION_FAILED");
                Completion.TrySetException(error);
            }
        }
        public void Abort() => Completion.TrySetException(new ObjectDisposedException(nameof(WindowsCoreAudioSessionFeed)));
    }

    private sealed class PendingSession(EndpointState endpoint, IntPtr session, bool intervalPending)
    {
        internal readonly EndpointState Endpoint = endpoint;
        internal readonly IntPtr Session = session;
        internal readonly bool IntervalPending = intervalPending;
    }

    internal sealed class EndpointState(WindowsCoreAudioSessionFeed owner, string endpointId,
        Action<SessionFeedEvent> changed)
    {
        internal readonly WindowsCoreAudioSessionFeed Owner = owner;
        internal readonly string EndpointId = endpointId;
        internal readonly Action<SessionFeedEvent> Changed = changed;
        internal readonly Dictionary<string, SessionEntry> Sessions = new(StringComparer.Ordinal);
        internal IntPtr Manager;
        internal IntPtr CreationSinkPointer;
        internal SessionCreatedSink? CreationSink;
        internal bool CreationRegistered;
        internal int Closed;
    }

    internal sealed class SessionEntry(EndpointState endpoint, IntPtr control)
    {
        internal readonly EndpointState Endpoint = endpoint;
        internal IntPtr Control = control;
        internal IntPtr SinkPointer;
        internal SessionEventsSink? Sink;
        internal bool Registered;
        internal string? InstanceId;
        internal int Invalidated;
        internal RawAudioSession? IdentitySnapshot;
        internal int ChangedBeforeIdentity;
    }

    private sealed class EndpointFeed(EndpointState state) : IEndpointSessionFeed
    {
        private int disposed;
        public string EndpointId => state.EndpointId;
        public RawAudioSession[] ReadSessions(CancellationToken cancellationToken)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            return state.Owner.Invoke(() => state.Owner.ReadSessions(state), cancellationToken);
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0)
                state.Owner.ScheduleCleanup(() => state.Owner.DisposeEndpoint(state));
        }
    }

    private sealed class TopologySubscription(WindowsCoreAudioSessionFeed owner,
        Action<SessionFeedEvent> changed) : IDisposable
    {
        internal readonly Action<SessionFeedEvent> Changed = changed;
        internal int Closed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref Closed, 1) == 0)
                owner.ScheduleCleanup(() => owner.DisposeSubscription(this));
        }
    }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None), SupportedOSPlatform("windows")]
public sealed class EndpointNotificationSink : IReadOnlyEndpointNotificationCallback
{
    private readonly WindowsCoreAudioSessionFeed owner;
    internal EndpointNotificationSink(WindowsCoreAudioSessionFeed owner) => this.owner = owner;
    public int OnDeviceStateChanged(IntPtr deviceId, uint newState) => owner.TopologyChanged("device-state", Marshal.PtrToStringUni(deviceId));
    public int OnDeviceAdded(IntPtr deviceId) => owner.TopologyChanged("device-added", Marshal.PtrToStringUni(deviceId));
    public int OnDeviceRemoved(IntPtr deviceId) => owner.TopologyChanged("device-removed", Marshal.PtrToStringUni(deviceId));
    public int OnDefaultDeviceChanged(int flow, int role, IntPtr defaultDeviceId) => owner.DefaultsChanged();
    public int OnPropertyValueChanged(IntPtr deviceId, ReadOnlyPropertyKey key) => owner.PropertiesChanged(Marshal.PtrToStringUni(deviceId), key);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None), SupportedOSPlatform("windows")]
public sealed class SessionCreatedSink : IReadOnlySessionCreatedCallback
{
    private readonly WindowsCoreAudioSessionFeed.EndpointState endpoint;
    internal SessionCreatedSink(WindowsCoreAudioSessionFeed.EndpointState endpoint) => this.endpoint = endpoint;
    public int OnSessionCreated(IntPtr newSession) => endpoint.Owner.SessionCreated(endpoint, newSession);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None), SupportedOSPlatform("windows")]
public sealed class SessionEventsSink : IReadOnlySessionEventsCallback
{
    private readonly WindowsCoreAudioSessionFeed.SessionEntry entry;
    internal SessionEventsSink(WindowsCoreAudioSessionFeed.SessionEntry entry) => this.entry = entry;
    public int OnDisplayNameChanged(IntPtr displayName, IntPtr eventContext) => 0;
    public int OnIconPathChanged(IntPtr iconPath, IntPtr eventContext) => 0;
    public int OnSimpleVolumeChanged(float newVolume, int newMute, IntPtr eventContext) => 0;
    public int OnChannelVolumeChanged(uint channelCount, IntPtr volumes, uint changedChannel, IntPtr eventContext) => 0;
    public int OnGroupingParamChanged(IntPtr groupingId, IntPtr eventContext) => entry.Endpoint.Owner.SessionChanged(entry, false, groupingChanged: true);
    public int OnStateChanged(int newState) => entry.Endpoint.Owner.SessionChanged(entry,
        newState == (int)AudioSessionState.Expired, newState);
    public int OnSessionDisconnected(int disconnectReason) => entry.Endpoint.Owner.SessionChanged(entry, true);
}
