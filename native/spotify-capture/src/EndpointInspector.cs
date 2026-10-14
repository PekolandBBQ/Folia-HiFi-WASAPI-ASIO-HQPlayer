using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Folia.Capture;

internal static class EndpointInspector
{
    internal static CaptureFormat Format(WaveFormat format)
    {
        var pointer = WaveFormat.MarshalToPtr(format);
        try
        {
            var bytes = new byte[format.Encoding == WaveFormatEncoding.Extensible ? 40 : 18];
            Marshal.Copy(pointer, bytes, 0, bytes.Length);
            return CaptureFormat.Parse(bytes);
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    internal static WaveFormat Wave(CaptureFormat format)
    {
        var bytes = format.ToWaveFormatEx(); var pointer = Marshal.AllocHGlobal(bytes.Length);
        try { Marshal.Copy(bytes, 0, pointer, bytes.Length); return WaveFormat.MarshalFromPtr(pointer); }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static BaseCableIdentityEvidence Identity(MMDevice endpoint, string? instanceId = null)
    {
        using var coldTiming = ColdTiming.Scope("capture.Identity");
        try
        {
            var identity = EndpointIdentityProbe.Read(endpoint.ID, instanceId ?? EndpointIdentityProbe.ReadInstanceId(endpoint.ID));
            if (identity.State == "unavailable") throw new CaptureFailure("BASE_CABLE_ENDPOINT_REQUIRED", identity.Hresult);
            return identity;
        }
        catch (NullReferenceException)
        {
            // NAudio's collection Item can wrap a null native device after losing its HRESULT.
            throw new CaptureFailure("ENDPOINT_UNAVAILABLE");
        }
    }

    private static EndpointEvidence Describe(MMDevice endpoint, BaseCableIdentityEvidence? observedIdentity = null, bool displayMetadata = true)
    {
        using var coldTiming = ColdTiming.Scope("capture.Describe");
        var flow = endpoint.DataFlow == DataFlow.Capture ? "capture"
            : endpoint.DataFlow == DataFlow.Render ? "render" : "unknown";
        var instanceId = EndpointIdentityProbe.ReadInstanceId(endpoint.ID);
        var identity = observedIdentity ?? Identity(endpoint, instanceId);
        // Resolve identity before opening an audio client. Names cannot activate unrelated audio.
        if (!BaseCableIdentity.Supported(flow, identity)) throw new CaptureFailure("BASE_CABLE_ENDPOINT_REQUIRED");
        using var client = endpoint.AudioClient;
        var format = Format(client.MixFormat);
        var friendlyName = displayMetadata ? endpoint.FriendlyName ?? string.Empty : string.Empty;
        // Friendly labels may be localized or name a pin's capacity (16 Ch). They establish
        // neither Base identity nor the actual engine channel count, checked independently below.
        var supported = BaseCableIdentity.Supported(flow, identity);
        uint? formFactor = null;
        // Optional standard metadata for display/preference only; never identity or format proof.
        if (displayMetadata) try
        {
            var properties = endpoint.Properties;
            var count = properties.Count;
            for (var index = 0; index < Math.Min(count, 256); index++)
            {
                if (!properties.Get(index).Equals(PropertyKeys.PKEY_AudioEndpoint_FormFactor)) continue;
                if (properties[index].Value is uint value && value <= 10) formFactor = value;
                break;
            }
        }
        catch (Exception error) when (EndpointInventoryReader.IsReadFailure(error)) { }
        return new(endpoint.ID, friendlyName, displayMetadata ? endpoint.DeviceFriendlyName : string.Empty,
            flow, instanceId, format, supported, BaseIdentity: identity, FormFactor: formFactor);
    }

    private sealed class NativeEndpointProbe(MMDevice endpoint) : IEndpointProbe<EndpointEvidence>
    {
        private BaseCableIdentityEvidence? identity;
        public bool Matches
        {
            get
            {
                identity ??= Identity(endpoint);
                return identity.State == "verified";
            }
        }
        public int State => (int)endpoint.State;
        public EndpointEvidence Describe() => EndpointInspector.Describe(endpoint, identity);
        public void Dispose() => endpoint.Dispose();
    }

    private sealed record SiblingEvidence(string Id, string[] Issues);
    private sealed class NativeSiblingProbe(MMDevice endpoint, string selectedId, BaseCableIdentityEvidence owner)
        : IEndpointProbe<SiblingEvidence>
    {
        public bool Matches => string.Equals(endpoint.ID, selectedId, StringComparison.OrdinalIgnoreCase)
            || BaseCableIdentity.SameOwner(Identity(endpoint), owner);
        public int State => (int)endpoint.State;
        public SiblingEvidence Describe()
        {
        using var coldTiming = ColdTiming.Scope("capture.Describe");
            if (endpoint.DataFlow != DataFlow.Render) throw new CaptureFailure("ENDPOINT_UNAVAILABLE");
            var id = endpoint.ID;
            if (string.IsNullOrWhiteSpace(id) || id.Length > 512) throw new CaptureFailure("ENDPOINT_UNAVAILABLE");
            if (string.Equals(id, selectedId, StringComparison.OrdinalIgnoreCase)) return new(id, []);
            // Process loopback excludes other writers on both cable pins. Only
            // endpoint identity is needed here to reject Folia output feedback.
            return new(id, []);
        }
        public void Dispose() => endpoint.Dispose();
    }

    private static (HashSet<string> Ids, string[] Issues) RenderSiblings(MMDeviceEnumerator enumerator,
        string selectedId, BaseCableIdentityEvidence owner)
    {
        using var coldTiming = ColdTiming.Scope("capture.RenderSiblings");
        EndpointInventory<SiblingEvidence> inventory;
        try
        {
            var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
            inventory = EndpointInventoryReader.Read(() => endpoints.Count,
                index => new NativeSiblingProbe(endpoints[index], selectedId, owner));
        }
        catch (Exception error) when (EndpointInventoryReader.IsReadFailure(error))
        { inventory = EndpointInventoryReader.Failed<SiblingEvidence>(error); }
        var ids = inventory.Endpoints.Select(item => item.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var issues = inventory.Endpoints.SelectMany(item => item.Issues).ToList();
        if (inventory.Diagnostics.State != "complete" || !ids.Contains(selectedId) || ids.Count != inventory.Endpoints.Length)
            issues.Add("ROUTE_OBSERVATION_FAILED");
        ids.Add(selectedId); // Preserve known selected/default feedback even if the sibling observation failed.
        return (ids, issues.Distinct().ToArray());
    }

    internal static EndpointInventory<EndpointEvidence> Devices()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            var endpoints = enumerator.EnumerateAudioEndPoints(DataFlow.All, DeviceState.All);
            // Do not activate or return unrelated microphones and physical output devices.
            return EndpointInventoryReader.Read(() => endpoints.Count, index => new NativeEndpointProbe(endpoints[index]));
        }
        catch (Exception error) when (EndpointInventoryReader.IsReadFailure(error))
        { return EndpointInventoryReader.Failed<EndpointEvidence>(error); }
    }

    internal static DefaultEndpointEvidence[] Defaults()
    {
        using var enumerator = new MMDeviceEnumerator();
        return Defaults(enumerator);
    }

    internal static object DefaultsObject(DefaultEndpointEvidence[] endpoints) => endpoints.ToDictionary(
        item => item.Flow + char.ToUpperInvariant(item.Role[0]) + item.Role[1..], item => item);

    internal static RenderSessionEvidence[] SpotifyProcesses()
    {
        var processes = Process.GetProcessesByName("Spotify");
        try
        {
            if (processes.Length > 128) throw new CaptureFailure("PROCESS_LIMIT");
            return processes.Select(process => ReadProcess(process.Id, "running", false))
                .Where(RoutePolicy.IsSpotify).ToArray();
        }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    internal static RenderSessionEvidence SpotifyProcess(int pid) => ReadProcess(pid, "running", false);

    private static DefaultEndpointEvidence[] Defaults(MMDeviceEnumerator enumerator, bool displayMetadata = true)
    {
        var defaults = new List<DefaultEndpointEvidence>();
        foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
        foreach (var role in new[] { Role.Console, Role.Multimedia, Role.Communications })
        {
            var flowName = flow == DataFlow.Render ? "render" : "capture";
            try
            {
                using var endpoint = enumerator.GetDefaultAudioEndpoint(flow, role);
                var id = endpoint.ID;
                string? name = null, deviceName = null;
                // Endpoint identity is safety evidence; friendly labels are optional metadata.
                if (displayMetadata) try { name = endpoint.FriendlyName; deviceName = endpoint.DeviceFriendlyName; }
                catch (COMException) { }
                defaults.Add(new(flowName, role.ToString().ToLowerInvariant(), true, id, name, deviceName));
            }
            catch (COMException error) { defaults.Add(new(flowName, role.ToString().ToLowerInvariant(), false, null, null, null, error.HResult)); }
        }
        return defaults.ToArray();
    }

    internal static ConfigurationEvidence Inspect(string captureId, string renderId, string? outputId, OwnedFormatLease? lease = null)
    {
        using var coldTiming = ColdTiming.Scope("capture.Inspect");
        if (string.IsNullOrWhiteSpace(captureId) || captureId.Length > 512 || string.IsNullOrWhiteSpace(renderId)
            || renderId.Length > 512 || outputId?.Length > 512) throw new CaptureFailure("INVALID_REQUEST");
        using var enumerator = new MMDeviceEnumerator();
        using var capture = enumerator.GetDevice(captureId);
        using var render = enumerator.GetDevice(renderId);
        if (capture.DataFlow != DataFlow.Capture || render.DataFlow != DataFlow.Render
            || capture.State != DeviceState.Active || render.State != DeviceState.Active)
            throw new CaptureFailure("ENDPOINT_UNAVAILABLE");
        var captured = Describe(capture, displayMetadata: false);
        var rendered = Describe(render, displayMetadata: false);
        FormatLeaseEvidence? formatLease = null;
        if (lease != null)
        {
            if (lease.CaptureId != captureId || lease.RenderId != renderId) throw new CaptureFailure("FORMAT_LEASE_ENDPOINT_MISMATCH");
            formatLease = lease.ReadEvidence();
            // The input pin is not opened by process capture. Keep its freshly
            // observed descriptor instead of presenting an old lease snapshot as live.
            rendered = rendered with { ConfiguredMixFormat = formatLease.Before.Render, MixFormat = formatLease.After.Render,
                MixFormatKind = "current-engine-format" };
        }
        var issues = new List<string>();
        if (!captured.SupportedBaseCable || !rendered.SupportedBaseCable
            || !BaseCableIdentity.SameOwner(captured.BaseIdentity, rendered.BaseIdentity)) issues.Add("BASE_CABLE_ENDPOINT_REQUIRED");
        // Process loopback supplies its own PCM format, independently of both VB pins.
        var defaults = Defaults(enumerator, displayMetadata: false);
        var siblings = RenderSiblings(enumerator, renderId, rendered.BaseIdentity!);
        var defaultRender = defaults.Any(item => item.Flow == "render" && item.Id != null && siblings.Ids.Contains(item.Id));
        var sessions = Sessions(render);
        var route = RoutePolicy.Evaluate(sessions, defaultRender, outputId != null && siblings.Ids.Contains(outputId), processCapture: true);
        if (siblings.Issues.Length != 0)
            route = route with { Ready = false, SpotifyOnlyObserved = false,
                Issues = route.Issues.Concat(siblings.Issues).Distinct().Order().ToArray() };
        // An unreadable render default is unknown, not evidence that CABLE is safe.
        if (route.EvidenceKind != "windows-process-tree-loopback" && defaults.Any(item => item.Flow == "render" && (!item.Available || string.IsNullOrWhiteSpace(item.Id))))
            route = route with { Ready = false, SpotifyOnlyObserved = false,
                Issues = route.Issues.Append("ROUTE_OBSERVATION_FAILED").Distinct().Order().ToArray() };
        issues.AddRange(route.Issues);
        var eligible = captured.SupportedBaseCable && rendered.SupportedBaseCable && route.Ready
            && issues.All(issue => issue is "CAPTURE_RATE_MISMATCH" or "RENDER_RATE_MISMATCH");
        return new(issues.Count == 0, issues.Distinct().Order().ToArray(), captured, rendered, route, sessions, defaults,
            TemporaryFormatLeaseEligible: eligible, FormatLease: formatLease);
    }

    private static RenderSessionEvidence[] Sessions(MMDevice endpoint)
    {
        using var coldTiming = ColdTiming.Scope("capture.Sessions");
        var result = new List<RenderSessionEvidence>();
        var sessions = endpoint.AudioSessionManager.Sessions;
        if (sessions.Count > 256) throw new CaptureFailure("ROUTE_SESSION_LIMIT");
        for (var index = 0; index < sessions.Count; index++)
        {
            using var session = sessions[index];
            var state = (int)session.State switch { 0 => "inactive", 1 => "active", _ => "expired" };
            var processId = checked((int)session.GetProcessID);
            var system = session.IsSystemSoundsSession;
            var evidence = ReadProcess(processId, state, system);
            // A released probe can remain enumerated on this pin, or a sibling after selection
            // changes. Match only this helper's exact created session, independently of a held lease.
            var ownedLease = processId == Environment.ProcessId && NativeFormatLease.RenderSessions.Owns(
                new(endpoint.ID, session.GetSessionInstanceIdentifier, session.GetGroupingParam()), evidence);
            result.Add(evidence with { IsOwnedFormatLease = ownedLease,
                IsOwnedActiveSilentFormatLease = ownedLease && state == "active" });
        }
        return result.ToArray();
    }

    private static RenderSessionEvidence ReadProcess(int processId, string state, bool system)
    {
        using var coldTiming = ColdTiming.Scope("capture.ReadProcess");
        string? name = null, image = null;
        var readable = false; long started = 0; string? ticks = null;
        if (processId > 0)
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                name = process.ProcessName; image = process.MainModule?.FileName;
                var utc = process.StartTime.ToUniversalTime();
                started = new DateTimeOffset(utc).ToUnixTimeMilliseconds();
                ticks = utc.Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
                readable = !string.IsNullOrEmpty(image) && started > 0 && !process.HasExited;
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
            { /* Unreadable active identity is rejected by RoutePolicy. */ }
        }
        return new(processId, state, name, image, system, readable, started, StartedAtUtcTicks: ticks);
    }
}
