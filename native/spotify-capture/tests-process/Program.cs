using Folia.Capture;

// Process-scoped capture eligibility differs from endpoint-mix eligibility.
var spotify = new RenderSessionEvidence(100, "active", "Spotify", @"C:\Spotify\Spotify.exe", false, true, 1);
var system = new RenderSessionEvidence(0, "active", "", null, true, true);
var other = new RenderSessionEvidence(200, "active", "browser", @"C:\browser.exe", false, true);
void Check(bool value) { if (!value) throw new Exception("Process route assertion failed"); }
Check(!RoutePolicy.Evaluate([spotify, system, other], true, false).Ready);
var isolated = RoutePolicy.Evaluate([spotify, system, other], true, false, processCapture: true);
Check(isolated.Ready && isolated.EvidenceKind == "windows-process-tree-loopback");
Check(!RoutePolicy.Evaluate([spotify], true, true, processCapture: true).Ready);
Check(!RoutePolicy.Evaluate([system, other], true, false, processCapture: true).Ready);
Check(!RoutePolicy.Evaluate([spotify, spotify with { ProcessId = 101 }], true, false, processCapture: true).Ready);
Console.WriteLine("PASS 5 process capture routing checks");
