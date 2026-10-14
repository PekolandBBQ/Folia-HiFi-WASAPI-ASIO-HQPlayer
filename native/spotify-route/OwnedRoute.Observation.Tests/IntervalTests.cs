using Folia.RouteObservation;

internal static class IntervalTests
{
    internal static int Run()
    {
        var count = 0;
        void Check(bool value) { if (!value) throw new Exception("Sticky capture interval assertion failed"); }
        void Test(string name, Action body) { body(); count++; Console.WriteLine("PASS interval " + name); }
        RawAudioSession Row(uint pid = 42, AudioSessionState state = AudioSessionState.Inactive,
            string endpoint = "base", int hr = 0, int system = 1) => new("session-" + pid, endpoint, state, pid, hr, system);
        SessionIsolationLedger Armed(params RawAudioSession[] rows) { var value = new SessionIsolationLedger(); value.Arm("base", 42, rows); return value; }
        Test("foreign burst ending before classification remains poisoned", () =>
        {
            var ledger = Armed(Row());
            var ticket = ledger.BeginPending("base"); Check(ticket && !ledger.Isolated);
            ledger.ObserveCreated(Row(90, AudioSessionState.Expired)); ledger.EndPending();
            ledger.ObserveExisting(Row()); Check(!ledger.Isolated);
        });
        Test("existing foreign active then inactive never clears history", () =>
        {
            var ledger = Armed(Row(), Row(90)); Check(ledger.Isolated);
            ledger.ObserveEvent("base", Row(90, AudioSessionState.Active));
            ledger.ObserveExisting(Row(90)); ledger.ObserveExisting(Row()); Check(!ledger.Isolated);
        });
        Test("unknown session identity cannot establish interval isolation", () =>
        {
            var ledger = Armed(Row()); ledger.ObserveCreated(Row(90, hr: RawAudioSession.NoSingleProcess)); Check(!ledger.Isolated);
        });
        Test("unclassified notification withdraws proof until owned classification", () =>
        {
            var ledger = Armed(Row()); Check(ledger.BeginPending("base")); Check(!ledger.Isolated);
            ledger.ObserveCreated(Row()); Check(!ledger.Isolated); ledger.EndPending(); Check(ledger.Isolated);
        });
        Test("selected source can create and activate its first Base session", () =>
        {
            var ledger = Armed(); ledger.ObserveCreated(Row()); ledger.ObserveEvent("base", Row(state: AudioSessionState.Active)); Check(ledger.Isolated);
        });
        Test("active foreign baseline cannot arm a clean interval", () => Check(!Armed(Row(90, AudioSessionState.Active)).Isolated));
        Test("foreign activity on another endpoint does not contaminate Base", () =>
        {
            var ledger = Armed(Row()); ledger.ObserveCreated(Row(90, AudioSessionState.Active, "physical"));
            ledger.ObserveEvent("physical", null); Check(ledger.Isolated);
        });
        Test("topology or lost coverage remains poisoned after clean rows", () =>
        {
            var ledger = Armed(Row()); ledger.Discontinuity(); ledger.ObserveExisting(Row()); Check(!ledger.Isolated);
        });
        Test("output device changes are scoped while Base or unknown loss remains sticky", () =>
        {
            var ledger = Armed(Row());
            Check(!ledger.PropertiesChanged("dac", "device-state") && ledger.Isolated);
            Check(!ledger.PropertiesChanged("dac", "endpoint-disposed") && ledger.Isolated);
            Check(!ledger.PropertiesChanged("dac", "endpoint-registration") && ledger.Isolated);
            Check(ledger.PropertiesChanged("base", "device-state") && !ledger.Isolated);
            ledger.ObserveExisting(Row()); Check(!ledger.Isolated);
            var unknown = Armed(Row()); Check(unknown.PropertiesChanged(null, "device-removed") && !unknown.Isolated);
        });
        Test("system sounds are foreign sample writers", () =>
        {
            var ledger = Armed(Row()); ledger.ObserveEvent("base", Row(0, AudioSessionState.Active, system: 0)); Check(!ledger.Isolated);
        });
        Test("one lifetime cannot rearm after contamination", () =>
        {
            var ledger = Armed(Row()); ledger.Discontinuity();
            try { ledger.Arm("base", 42, [Row()]); throw new Exception("Rearm accepted"); }
            catch (InvalidOperationException error) when (error.Message == "INTERVAL_ALREADY_ARMED") { }
            Check(!ledger.Isolated);
        });
        Test("unknown callback on selected endpoint is sticky", () =>
        {
            var ledger = Armed(Row()); ledger.ObserveEvent("base", null); ledger.ObserveCreated(Row()); Check(!ledger.Isolated);
        });
        Test("a preexisting inactive foreign session poisons only after an event", () =>
        {
            var ledger = Armed(Row(), Row(90)); Check(ledger.Isolated);
            ledger.ObserveEvent("base", Row(90)); Check(!ledger.Isolated);
        });
        Test("format lease created before first arm does not poison buffered interval", () =>
        {
            var ledger = new SessionIsolationLedger(); ledger.ObserveCreated(Row(90));
            ledger.Arm("base", 42, [Row(90)]);
            ledger.ObserveCreated(Row()); ledger.ObserveEvent("base", Row(state: AudioSessionState.Active));
            Check(ledger.Isolated);
        });
        return count;
    }
}
