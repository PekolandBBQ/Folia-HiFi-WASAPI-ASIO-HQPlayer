using System.Text.Json;
using Folia.Capture;

// tests-readback/Program.cs: only the newly observed format-readback failure and its bounded propagation.
var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
var requested = new CaptureFormat(44100, 2, 32, 32, 8, 352800, "float", 3, CaptureFormat.FloatSubtype.ToString());
var passed = 0;
void Check(bool condition, string reason) { if (!condition) throw new Exception(reason); }
void Run(string name, Action action)
{ EngineScenario.Reset(); action(); passed++; Console.WriteLine("PASS ReadbackFailure: " + name); }
CaptureFailure Failure(Action action, string code = "FORMAT_LEASE_READBACK_MISMATCH")
{
    try { action(); }
    catch (CaptureFailure failure) when (failure.Code == code) { return failure; }
    throw new Exception("Expected " + code);
}
JsonElement Wire(object value) => JsonSerializer.SerializeToElement(value, json);
string[] Fields(FormatLeaseReadbackEvidence evidence) => evidence.DifferingFields.ToArray();

Run("capture rate mismatch keeps the existing failure and both actually compared descriptors", () =>
{
    var observed = requested with { SampleRate = 48000, AverageBytesPerSecond = 384000 };
    var failure = Failure(() => FormatLeasePolicy.RequireReadback(observed, 448, requested, "capture"));
    var evidence = failure.FormatLeaseReadback!;
    Check(failure.NativeHResult == null && evidence.EndpointRole == "capture" && evidence.Comparison == "rate-or-channels"
        && evidence.PeriodFrames == 448 && evidence.Requested.SampleRate == 44100 && evidence.Observed.SampleRate == 48000
        && Fields(evidence).SequenceEqual(new[] { "sampleRate", "averageBytesPerSecond" }), "Rate mismatch was weakened or misreported");
});
Run("render channel mismatch is distinct from a full descriptor mismatch", () =>
{
    var observed = requested with { Channels = 1, BlockAlign = 4, AverageBytesPerSecond = 176400 };
    var evidence = Failure(() => FormatLeasePolicy.RequireReadback(observed, 448, requested, "render")).FormatLeaseReadback!;
    Check(evidence.EndpointRole == "render" && evidence.Comparison == "rate-or-channels"
        && Fields(evidence).SequenceEqual(new[] { "channels", "blockAlign", "averageBytesPerSecond" }), "Channel mismatch lacked exact comparison facts");
});
Run("a supported descriptor difference still rejects and identifies only the differing original field", () =>
{
    var observed = requested with { ChannelMask = 0 };
    var evidence = Failure(() => FormatLeasePolicy.RequireReadback(observed, 448, requested, "render")).FormatLeaseReadback!;
    Check(evidence.Comparison == "descriptor" && Fields(evidence).SequenceEqual(new[] { "channelMask" })
        && evidence.Requested.ChannelMask == 3 && evidence.Observed.ChannelMask == 0, "Exact comparison was relaxed or relabeled");
});
Run("unknown subtype values remain distinct without exposing either original string", () =>
{
    var first = requested with { SubFormat = "PRIVATE_SUBTYPE_A" };
    var second = requested with { SubFormat = "PRIVATE_SUBTYPE_B" };
    var evidence = Failure(() => FormatLeasePolicy.RequireReadback(second, 448, first, "capture")).FormatLeaseReadback!;
    Check(evidence.Requested.SubFormatKind == "other" && evidence.Observed.SubFormatKind == "other"
        && Fields(evidence).SequenceEqual(new[] { "subFormatKind" }) && !Wire(evidence).GetRawText().Contains("PRIVATE"),
        "Sanitized subtype kinds hid a real comparison difference or exposed raw input");
});
Run("missing request or native direction never fabricates format evidence", () =>
{
    var observed = requested with { SampleRate = 48000 };
    foreach (var role in new string?[] { null, "PRIVATE_ROLE", "output" })
        Check(Failure(() => FormatLeasePolicy.RequireReadback(observed, 448, requested, role)).FormatLeaseReadback == null,
            "Unbound native role was invented");
    Check(Failure(() => FormatLeasePolicy.RequireReadback(observed, 448, null, "capture")).FormatLeaseReadback == null,
        "Missing requested descriptor was invented");
});
Run("the nine bounded fields preserve raw differences with closed text categories", () =>
{
    var observed = new CaptureFormat(-1, 1, 24, 16, 3, int.MinValue, "PRIVATE_ENCODING", uint.MaxValue, "PRIVATE_SUBTYPE");
    var evidence = Failure(() => FormatLeasePolicy.RequireReadback(observed, uint.MaxValue, requested, "capture")).FormatLeaseReadback!;
    var fields = new[] { "sampleRate", "channels", "containerBits", "validBits", "blockAlign", "averageBytesPerSecond", "encoding", "channelMask", "subFormatKind" };
    Check(Fields(evidence).SequenceEqual(fields) && evidence.Observed.Encoding == "unsupported"
        && evidence.Observed.SubFormatKind == "other" && evidence.Observed.AverageBytesPerSecond == int.MinValue
        && evidence.Observed.ChannelMask == uint.MaxValue && evidence.PeriodFrames == uint.MaxValue
        && Wire(evidence.Observed).EnumerateObject().Select(value => value.Name).SequenceEqual(fields)
        && !Wire(evidence).GetRawText().Contains("PRIVATE"), "New evidence escaped the fixed nine-field projection");
});
Run("unchanged descriptors preserve the exact object and non-mismatch errors gain no new details", () =>
{
    Check(ReferenceEquals(FormatLeasePolicy.RequireReadback(requested, 448, requested, "capture"), requested), "Readback changed the accepted descriptor");
    Check(Failure(() => FormatLeasePolicy.RequireReadback(requested, 0, requested, "capture"), "FORMAT_LEASE_READBACK_FAILED").FormatLeaseReadback == null,
        "A different failure gained mismatch evidence");
    var wrong = Failure(() => FormatLeasePolicy.RequireReadback(requested with { SampleRate = 48000 }, 448, requested, "capture"));
    Check(CaptureFailureDiagnostic.For("CAPTURE_DEVICE_FAILED", wrong, null).FormatLeaseReadback == null,
        "Evidence crossed its exact originating error code");
    var closed = Wire(new CaptureTerminalEvidence("test", 1, "closed", null, 0, 0, 0, null, null, "closed", true));
    Check(!closed.TryGetProperty("formatLeaseReadback", out _), "Normal close gained mismatch evidence");
});


Run("process capture ignores VB format changes and opens no capture-pin format lease", () =>
{
    var events = new List<object>(); using var engine = new CaptureEngine(events.Add);
    JsonElement Request(string action) => Wire(new { action, session = "00000000-0000-0000-0000-000000000001", generation = 1,
        captureDeviceId = "capture", renderDeviceId = "render", temporaryFormatLease = true,
        pipeName = "folia-capture-" + Guid.NewGuid().ToString("N") });
    engine.Command(Request("capture-open")); engine.Command(Request("capture-start"));
    EngineScenario.Sessions[0].CapturedFrames = 78939;
    Check(EngineScenario.Endpoints.Count == 1 && EngineScenario.Endpoints[0].EndpointId == "render", "Opened obsolete VB capture format lease");
    EngineScenario.Endpoints[0].ReadbackOverride = requested with { SampleRate = 96000, AverageBytesPerSecond = 768000, ChannelMask = 0 };
    Thread.Sleep(260); engine.Tick();
    Check(events.Count == 0, "Endpoint descriptor change stopped independent process capture");
    engine.Command(Request("capture-stop"));
});
Run("failed open returns compared format details and permits another preparation after cleanup", () =>
{
    using var engine = new CaptureEngine(_ => { });
    var failure = Failure(() => FormatLeasePolicy.RequireReadback(requested with { ChannelMask = 0 }, 448, requested, "render"));
    EngineScenario.AcquisitionFailure = _ => failure;
    JsonElement Request(int generation) => Wire(new { action = "capture-open", session = "00000000-0000-0000-0000-000000000002", generation,
        captureDeviceId = "capture", renderDeviceId = "render", temporaryFormatLease = true,
        pipeName = "folia-capture-" + Guid.NewGuid().ToString("N") });
    var rejected = Wire(engine.Command(Request(1)));
    Check(rejected.GetProperty("errorCode").GetString() == "FORMAT_LEASE_READBACK_MISMATCH"
        && rejected.GetProperty("formatLeaseReadback").GetProperty("differingFields")[0].GetString() == "channelMask", "Open swallowed format comparison");
    EngineScenario.AcquisitionFailure = null;
    Check(Wire(engine.Command(Request(2))).GetProperty("state").GetString() != "configuration-required", "Failed open poisoned reusable capture");
});
Console.WriteLine($"PASS {passed} targeted format and process capture tests; no Windows API or device was used.");
