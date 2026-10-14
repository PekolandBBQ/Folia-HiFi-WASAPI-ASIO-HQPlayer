using Folia.RouteRunner;
using Folia.RouteResearch;
using Folia.Capture;
int passed=0;
void Test(string name,Action action) { action(); passed++; Console.WriteLine("PASS "+name); }
void Require(bool value) { if(!value) throw new Exception("Assertion failed"); }
void Reject(Action action) { try { action(); } catch(ArgumentException) { return; } throw new Exception("Expected rejection"); }
Test("no arguments chooses read-only preflight",()=>Require(Options.Parse([]).Mode=="preflight"));
Test("roundtrip cannot infer exact process",()=>Reject(()=>Options.Parse(["--roundtrip"])));
Test("mutating modes are exclusive",()=>Reject(()=>Options.Parse(["--roundtrip","--restore"])));
Test("duplicate PID rejected",()=>Reject(()=>Options.Parse(["--pid","1","--pid","2"])));
Test("unknown flags rejected",()=>Reject(()=>Options.Parse(["--set-default"])));
Test("nonpositive PID rejected",()=>Reject(()=>Options.Parse(["--pid","0"])));
Test("roundtrip requires all attestations",()=>Reject(()=>Options.Parse(["--roundtrip","--pid","1","--journal","/tmp/sample.jsonl","--reviewed-build","28000","--abi-review","test","--target",Options.DefaultTarget])));
Test("restore needs no playback attestations",()=>Require(Options.Parse(["--restore","--pid","1","--journal","/tmp/sample.jsonl","--reviewed-build","28000","--abi-review","test"]).Mode=="restore"));
Test("full roundtrip request parsed without playback action",()=>Require(Options.Parse(["--roundtrip","--pid","1","--journal","/tmp/sample.jsonl","--reviewed-build","28000","--abi-review","test","--target",Options.DefaultTarget,"--attest-default-output","--attest-exclusive-off","--attest-paused","--attest-short-ui-play","--original-endpoint","physical","--expected-start-time-utc-ticks","456"]).Paused));
var wrapper="\\\\?\\SWD#MMDEVAPI#"+Options.DefaultTarget+"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
Test("actual observed wrapper maps exact raw MMDevice ID",()=>Require(AudioReadOnly.TryMapPolicy(wrapper,out var id)&&id==Options.DefaultTarget));
Test("raw MMDevice ID is not accepted as policy value",()=>Require(!AudioReadOnly.TryMapPolicy(Options.DefaultTarget,out _)));
Test("capture wrapper never maps to render",()=>Require(!AudioReadOnly.TryMapPolicy(wrapper.Replace("e6327cad-dcec-4949-ae8a-991e976a79d2","2eef81be-33fa-4800-9670-1cd474972c3f"),out _)));
Test("malformed endpoint wrapper rejected",()=>Require(!AudioReadOnly.TryMapPolicy(wrapper.Replace("95216355","zzzzzzzz"),out _)));
Test("platform preflight never enters native calls on Linux",()=> { if(!OperatingSystem.IsWindows()) Require(Worker.Run([])==2); });
var owner=new BaseCableIdentityEvidence("verified",@"ROOT\MEDIA\0001");
var speaker=new EndpointInfo(Options.DefaultTarget,"Speakers",1,0,1,"",owner,wrapper,48000,2);
var capture=new EndpointInfo("capture-id","CABLE Out",1,1,0,"",owner,null,44100,2);
void BlockSelect(EndpointInfo[] items)
{ try { AudioReadOnly.SelectVerified(speaker.Id,items); } catch(RouteBlockedException) { return; } throw new Exception("Unsafe target accepted"); }
Test("ordinary Base speaker requires its same-owner active capture",()=>Require(AudioReadOnly.SelectVerified(speaker.Id,[speaker,capture]).Eligible));
Test("missing capture rejects target",()=>BlockSelect([speaker]));
Test("inactive capture rejects target",()=>BlockSelect([speaker,capture with {State=2}]));
Test("capture from another Base owner rejects target",()=>BlockSelect([speaker,capture with {BaseIdentity=owner with {OwnerInstanceId=@"ROOT\MEDIA\0002"}}]));
Test("two active same-owner captures are ambiguous",()=>BlockSelect([speaker,capture,capture with {Id="second-capture"}]));
Test("friendly name cannot replace Speakers form factor",()=>BlockSelect([speaker with {FormFactor=0},capture]));
Test("unknown Base identity blocks ordinary speaker",()=>BlockSelect([speaker with {BaseIdentity=new("unavailable")},capture]));
Test("second same-owner ordinary speaker is ambiguous",()=>BlockSelect([speaker,capture,speaker with {Id="other-speaker"}]));
Test("policy interface mapping required independently of MMDevice ID",()=>BlockSelect([speaker with {PolicyValue=null},capture]));
Test("16Ch sibling never substitutes for ordinary speaker identity",()=>Require(AudioReadOnly.SelectVerified(speaker.Id,[speaker,capture,speaker with {Id="16Ch",FormFactor=0}]).Id==speaker.Id));
var process=new SpotifyProcess(123,456,"sid","policy","image","desktop");
Test("target observation remains incomplete snapshot",()=>
{
    var snapshot=SnapshotFacts.ForProcess(process,[new(123,"session-1",speaker.Id,1,0,1)]);
    Require(!snapshot.CompleteForProcess && SnapshotFacts.HasActiveOn(snapshot,speaker.Id));
});
Test("another PID cannot become selected Spotify observation",()=>Require(!SnapshotFacts.HasActiveOn(SnapshotFacts.ForProcess(process,[new(124,"other",speaker.Id,1,0,1)]),speaker.Id)));
Test("inactive selected session is not active target observation",()=>Require(!SnapshotFacts.HasActiveOn(SnapshotFacts.ForProcess(process,[new(123,"inactive",speaker.Id,0,0,1)]),speaker.Id)));
var testPath=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"run-proof.jsonl")); const string fileId="12345678:0000000000000001";
string Marker(string path,string identity)=>System.Text.Json.JsonSerializer.Serialize(new {status="JOURNAL_CREATED",evidence=new{path,fileIdentity=identity}});
Test("legacy creation marker cannot grant retained Prepared authority",()=>{var proof=new RunJournalProof(testPath);proof.ObserveLine(Marker(testPath,fileId));Require(proof.Get()==null);});
Test("existing path alone supplies no proof",()=>Require(new RunJournalProof(testPath).Get()==null));
Test("marker for another path is rejected",()=>{var proof=new RunJournalProof(testPath);proof.ObserveLine(Marker(testPath+"-old",fileId));Require(proof.Get()==null);});
Test("malformed file identity is rejected",()=>{var proof=new RunJournalProof(testPath);proof.ObserveLine(Marker(testPath,"123"));Require(proof.Get()==null);});
Test("duplicate markers cannot replace journal ownership",()=>{var proof=new RunJournalProof(testPath);proof.ObserveLine(Marker(testPath,fileId));proof.ObserveLine(Marker(testPath,fileId));Require(proof.Get()==null);});
Test("recovery rejects changed file identity",()=>{try{JournalGuard.RequireExpectedIdentity("12345678:0000000000000002",fileId);}catch(JournalUnavailableException){return;}throw new Exception("Replaced journal accepted");});
Test("recovery accepts the exact original file identity",()=>JournalGuard.RequireExpectedIdentity(fileId,fileId));
Test("internal recovery without current-run marker identity fails before Windows IO",()=>
{
    var original=Console.Out;using var output=new StringWriter();Console.SetOut(output);int code;
    try{code=Worker.Recover([]);}finally{Console.SetOut(original);}
    Require(code==4 && output.ToString().Contains("CURRENT_RUN_JOURNAL_OWNERSHIP_REQUIRED"));
});
Test("visible mixed endpoints do not qualify as target-only snapshot",()=>Require(!SnapshotFacts.HasActiveOn(SnapshotFacts.ForProcess(process,[new(123,"target",speaker.Id,1,0,1),new(123,"elsewhere","physical",1,0,1)]),speaker.Id)));
Test("no observed active session never becomes positive target fact",()=>Require(!SnapshotFacts.HasActiveOn(SnapshotFacts.ForProcess(process,[]),speaker.Id)));
Test("documented cross-process success retains raw PID and exact HRESULT",()=>
{
    var row=SessionIdentity.Decode(4242,SessionIdentity.NoSingleProcess,"cross","physical",1);
    Require(row.ReportedProcessId==4242 && row.ProcessIdHResultHex=="0x0889000D" && !row.HasSingleProcessIdentity && row.ProcessIdentityStatus=="AUDCLNT_S_NO_SINGLE_PROCESS");
});
Test("unknown positive success remains diagnostic-only and preserves code",()=>
{
    var row=SessionIdentity.Decode(7,1,"unknown","physical",0);
    Require(row.ReportedProcessId==7 && row.ProcessIdHResult==1 && !row.HasSingleProcessIdentity);
});
Test("successful single-process PID remains available for independent verification",()=>Require(SessionIdentity.Decode(4242,0,"single","physical",0).HasSingleProcessIdentity));
Test("full unsigned reported PID is retained without inventing ownership",()=>
{
    var row=SessionIdentity.Decode(uint.MaxValue,0,"large","physical",0);
    Require(row.ReportedProcessId==uint.MaxValue && !row.HasSingleProcessIdentity);
});
Test("fatal GetProcessId HRESULT is not swallowed or rewritten",()=>
{
    const int hr=unchecked((int)0x88890004u);
    try{SessionIdentity.Decode(0,hr,"failure","physical",0);}
    catch(System.Runtime.InteropServices.COMException e){Require(e.HResult==hr);return;}
    throw new Exception("Fatal HRESULT was swallowed");
});
Test("unrelated cross-process row does not abort read-only noPID diagnostics",()=>
{
    var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);
    try
    {
        var rows=ReadOnlyDiagnostics.Scan(()=>new[]{4242},()=>
        {
            Require(output.ToString().Contains("SPOTIFY_CANDIDATES"));
            return new[]{SessionIdentity.Decode(99,SessionIdentity.NoSingleProcess,"other","physical",1),SessionIdentity.Decode(4242,0,"spotify","physical",0)};
        });
        Require(rows.Length==2 && output.ToString().Contains("READONLY_SESSIONS") && output.ToString().Contains("\"ambiguousIdentityRows\":1"));
    }
    finally{Console.SetOut(old);}
});
Test("candidate PID evidence survives a subsequent fatal session read",()=>
{
    var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);bool failed=false;
    try{try{ReadOnlyDiagnostics.Scan(()=>new[]{4242},()=>throw new System.Runtime.InteropServices.COMException("fatal",unchecked((int)0x88890004u)));}catch(System.Runtime.InteropServices.COMException){failed=true;}}
    finally{Console.SetOut(old);}
    Require(failed && output.ToString().Contains("SPOTIFY_CANDIDATES") && !output.ToString().Contains("READONLY_SESSIONS"));
});
Test("any ambiguous identity blocks apply even when unrelated to Spotify",()=>
{
    try{SessionIdentity.RequireUnambiguousForApply([SessionIdentity.Decode(99,SessionIdentity.NoSingleProcess,"other","physical",1),SessionIdentity.Decode(4242,0,"spotify","target",0)]);}
    catch(RouteBlockedException e){Require(e.Message=="SESSION_IDENTITY_AMBIGUOUS_APPLY_BLOCKED");return;}
    throw new Exception("Ambiguous inventory allowed apply");
});
Test("cross-process creator PID cannot count as selected Spotify target observation",()=>
{
    var ambiguous=SessionIdentity.Decode((uint)process.Pid,SessionIdentity.NoSingleProcess,"cross","target",1);
    var facts=SnapshotFacts.ForProcess(process,[ambiguous]);
    Require(facts.Sessions.Length==0 && !SnapshotFacts.HasActiveOn(facts,"target") && !facts.CompleteForProcess);
});
passed+=RoundtripTests.Run();
passed+=JournalPathTests.Run();
passed+=StorageCapabilityTests.Run();
passed+=JournalHandoffTests.Run();
Console.WriteLine($"HOST_TESTS_PASSED={passed}");
