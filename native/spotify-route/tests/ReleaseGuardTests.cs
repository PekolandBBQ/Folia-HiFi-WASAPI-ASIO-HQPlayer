using Folia.RouteRunner;
using Folia.RouteResearch;

var passed=0;
void Test(string name,Action action) { action(); passed++;Console.WriteLine("PASS "+name); }
void Require(bool condition) { if(!condition)throw new Exception("Release guard assertion failed"); }
void Reject(Action action) {try{action();}catch(Exception e)when(e is ArgumentException or FormatException or OverflowException or RouteBlockedException){return;}throw new Exception("Expected rejection");}
string[] BaseArgs()=>["--roundtrip","--pid","44444","--target",Options.DefaultTarget,"--original-endpoint","{0.0.0.00000000}.{3822d6bf-2897-44b3-a7b1-36cc7c0aa7a2}","--journal","/tmp/fresh-guid.jsonl","--reviewed-build","28000","--abi-review","device-free","--attest-default-output","--attest-exclusive-off","--attest-paused","--attest-short-ui-play"];
Options WithTicks(string ticks)=>Options.Parse(BaseArgs().Concat(new[]{"--expected-start-time-utc-ticks",ticks}).ToArray());
const long ticks=639270164388495164;
var identity=new SpotifyProcess(44444,ticks,"sid","policy","image","distribution");
Test("exact rev31 decimal parses losslessly beyond binary64 integer range",()=>Require(WithTicks("639270164388495164").ExpectedStartTimeUtcTicks==ticks));
Test("roundtrip without explicit expected ticks is rejected",()=>Reject(()=>Options.Parse(BaseArgs())));
foreach(var text in new[]{"0","-1","639270164388495164.0","6.39270164388495164e17","639,270,164,388,495,164","9223372036854775808"})
    Test("noncanonical or invalid tick input rejected: "+text,()=>Reject(()=>WithTicks(text)));
Test("same held process start is accepted",()=>Worker.RequireExpectedProcessStart(identity,ticks));
Test("one-tick process difference is rejected",()=>Reject(()=>Worker.RequireExpectedProcessStart(identity with {StartTimeUtcTicks=ticks+1},ticks)));
Test("rounded summary value is not the original identity",()=>Reject(()=>Worker.RequireExpectedProcessStart(identity,639270164388495200)));
Test("readonly no-argument preflight remains available",()=>Require(Options.Parse([]).Mode=="preflight"));
Test("explicit restore still uses separate journal recovery identity",()=>Require(Options.Parse(["--restore","--pid","44444","--journal","/tmp/existing.jsonl","--reviewed-build","28000","--abi-review","device-free"]).ExpectedStartTimeUtcTicks==null));
Console.WriteLine("RELEASE_GUARD_TESTS_PASSED="+passed);
