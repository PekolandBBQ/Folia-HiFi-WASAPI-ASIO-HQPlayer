using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;

var passed=0;
void Check(bool condition,string message) {if(!condition) throw new Exception(message);}
void Run(string name,Action action) {action();passed++;Console.WriteLine("PASS "+name);}
ServiceReply Send(ProductRouteService s,string command,object? payload=null)=>s.Dispatch(JsonSerializer.Serialize(new {id="test",command,payload=payload??new{}}));
object AcquireArgs(Fake p,string session="product",int generation=1)=>new {session,generation,sourcePaused=true,sourceDeviceId="official-device",expectedSourceUri="spotify:track:baseline",captureDeviceId="BASE-capture",renderDeviceId="BASE-render",expectedSpotifyProcessId=p.Live.Pid,expectedSpotifyStartTimeUtcTicks=ProcessWire.From(p.Live).StartTimeUtcTicks};
JsonElement Lease(ServiceReply r)=>JsonSerializer.SerializeToElement(r.Lease,new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase});
object Key(ServiceReply r,int generation=1)=>new {session="product",generation,leaseId=Lease(r).GetProperty("leaseId").GetString()};
object ResumeArgs(ServiceReply r,bool capture=true,bool mute=true)=>new {session="product",generation=1,leaseId=Lease(r).GetProperty("leaseId").GetString(),captureStarted=capture,monitorGainZero=mute,selectedSourceUri="spotify:track:owned"};
void Restored(Fake p)=>Check(p.Values.SequenceEqual(p.Originals),"Originals did not match exact nullable/communication originals");

Run("paused player waits for delayed native inactive session within budget",()=>{
    var p=new Fake {TransientActiveScans=2};var control=new SourceFake(p);
    new SourcePauseVerifier(control,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live));
    Check(p.Observations==3 && p.Writes.Count==0,"Did not await native session or changed policy");
});

Run("shipping backend rejects every acquisition without route adapters",()=>
{
    using var s=new ProductRouteService(new UnqualifiedProductBackend());
    var hello=Send(s,"hello",new{protocolMajor=1});
    Check(hello.Ok && hello.State=="unsupported" && hello.Capabilities?.Supported==false,"Shipping gate opened");
    var r=Send(s,"acquire",new{});Check(!r.Ok && r.Code=="NATIVE_PRODUCT_ADAPTER_UNQUALIFIED"&&!s.HasLease,"Shipping acquired");
});
Run("capability conjunction prevents partially qualified adapter access",()=>
{
    var p=new Fake {Capabilities=Fake.Qualified with {CompleteSessionProof=false}};using var s=p.Service();
    Check(!Send(s,"inspect",new{captureDeviceId="BASE-capture",renderDeviceId="BASE-render"}).Ok && p.Inspects==0,"Capability omission called backend");
});
Run("paused bootstrap writes two roles only after durable retained ACK without sessions",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(r.Ok&&r.State=="heldPaused"&&!r.Ready&&p.Observations==0,"Paused route was falsely ready or required source audio");
    Check(p.Trace.IndexOf("ack")<p.Trace.IndexOf("set:Console:base-policy")&&p.Writes.Count==2,"Setter preceded retained Prepared ACK");
    Check(p.Writes.All(x=>x.Role!=RenderRole.Communications),"Communications mutation");
    Check(Send(s,"status",Key(r)).State=="heldPaused"&&p.Observations==0,"Held status required playback");
    var done=Send(s,"release",Key(r));Check(done.Ok&&done.ExactOriginalRolesRestored&&done.DefaultsUnchanged,"No terminal proof");Restored(p);
});
Run("resume authorization requires private capture and zero PCM gate then complete proof",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.IntervalArmed&&!Send(s,"authorizeResume",ResumeArgs(r)).Ok,"Unarmed resume permitted");
    Check(Send(s,"armCaptureInterval",Key(r)).IntervalArmed,"Explicit pre-start arm failed");
    Check(!Send(s,"authorizeResume",ResumeArgs(r,capture:false)).Ok,"No-capture resume permitted");
    Check(!Send(s,"authorizeResume",ResumeArgs(r,mute:false)).Ok,"Audible-gate resume permitted");
    var permit=Send(s,"authorizeResume",ResumeArgs(r));Check(permit.ResumeAuthorized&&!permit.Ready&&p.Observations==0,"Permit claimed ready");
    Check(!Send(s,"authorizeResume",ResumeArgs(r)).Ok,"Permit replay accepted");
    p.Paused=false;var active=Send(s,"status",Key(r));Check(active.Ok&&active.Ready&&active.State=="active"&&p.Observations==1,"Complete proof did not activate");
    Check(!Send(s,"heartbeat",Key(r)).Ready,"Heartbeat advertised fresh audio proof");
});
Run("partial A025 observation cannot become product readiness",()=>
{
    var p=new Fake{Complete=false};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));Send(s,"armCaptureInterval",Key(r));Send(s,"authorizeResume",ResumeArgs(r));p.Paused=false;
    var result=Send(s,"status",Key(r));Check(!result.Ok&&!result.Ready&&result.Code=="SESSION_OBSERVATION_UNTRUSTED","Partial snapshot accepted");
    p.Paused=true;Check(Send(s,"release",Key(r)).Ok,"Partial proof prevented owned cleanup");Restored(p);
});
Run("mismatched Prepared receipt and missing ACK issue zero setters",()=>
{
    foreach(var fault in new[]{"ack","transaction","retained","root"})
    {
        var p=new Fake{ReceiptFault=fault};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
        Check(!r.Ok&&!r.Ready&&p.Writes.Count==0,"Bad proof authorized setter: "+fault);
        Check(!Send(s,"release",Key(r)).Ok&&p.Writes.Count==0,"Ambiguous ACK allowed same-worker mutation");
    }
});
Run("fresh originals mismatch cannot be hidden by prepare",()=>
{
    var p=new Fake{ChangeBeforePrepare=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ok&&p.Writes.Count==0,"Changed source policy was overwritten");
});
Run("stale precise process start rejected before opening ownership",()=>
{
    var p=new Fake();using var s=p.Service();var ticks=ProcessWire.From(p.Live).StartTimeUtcTicks;
    var r=Send(s,"acquire",new {session="product",generation=1,sourcePaused=true,sourceDeviceId="official-device",expectedSourceUri="spotify:track:baseline",captureDeviceId="BASE-capture",renderDeviceId="BASE-render",expectedSpotifyProcessId=p.Live.Pid,expectedSpotifyStartTimeUtcTicks=(long.Parse(ticks)+1).ToString()});
    Check(!r.Ok&&!s.HasLease&&p.Writes.Count==0,"One-tick process identity change accepted");
});
Run("source pause is verified independently of request assertion",()=>
{
    var p=new Fake{Paused=false};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ok&&p.Writes.Count==0,"Caller pause assertion trusted blindly");
});
Run("PID reuse withdraws readiness and forbids automatic reidentity",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));p.Live=p.Live with{StartTimeUtcTicks=p.Live.StartTimeUtcTicks+1};
    var status=Send(s,"status",Key(r));Check(!status.Ok&&!status.Ready&&p.Writes.Count==2,"PID reused without rejection");
    Check(!Send(s,"release",Key(r)).Ok,"New process silently adopted for restore");
});
Run("another generation cannot release current lease; repeat acquire refused",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!Send(s,"acquire",AcquireArgs(p,"other",2)).Ok,"Second acquire adopted current route");
    Check(!Send(s,"release",Key(r,2)).Ok&&p.Writes.Count==2,"Wrong generation restored route");
    Check(Send(s,"release",Key(r)).Ok&&Send(s,"release",Key(r)).Ok,"Exact idempotent release failed");Restored(p);
});
Run("external policy conflict is preserved without partial restore",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));p.Values[1]="external-choice";
    var done=Send(s,"release",Key(r));Check(!done.Ok&&!done.ExactOriginalRolesRestored&&p.Writes.Count==2,"Conflict overwritten");
    Check(p.Values[1]=="external-choice"&&p.Values[0]=="base-policy","Conflict changed remaining policy");
});
Run("setter throw after write compensates exact originals",()=>
{
    var p=new Fake{ThrowAfterFirstWrite=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ready&&p.Writes.Count==2,"Uncertain setter not compensated");Restored(p);
    Check(Send(s,"release",Key(r)).ExactOriginalRolesRestored,"Compensated record not verified");
});
Run("journal acknowledgement failure after first write stops all worker writes",()=>
{
    var p=new Fake{FailAppliedCommit=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ok&&p.Writes.Count==1,"Failed commit did not stop writes");
    Check(!Send(s,"release",Key(r)).Ok&&p.Writes.Count==1,"Same-worker restore after unknown commit");
});
Run("ownership loss between roles prevents second apply and preserves recovery",()=>
{
    var p=new Fake{LoseOwnershipAfterWrite=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ok&&!r.Ready&&p.Writes.Count==1,"Ownership loss allowed second setter");
});
Run("idle lease expiry restores once and closes",()=>
{
    var p=new Fake();using var s=p.Service();Send(s,"acquire",AcquireArgs(p));p.Now+=ProductRouteService.IdleLimit;
    var ended=s.CheckDeadline();Check(ended?.Ok==true&&ended.ExactOriginalRolesRestored&&s.Closed,"Idle child did not restore");
    Restored(p);Check(s.CheckDeadline() is null&&p.Writes.Count==4,"Cleanup repeated");
});
Run("EOF and invalid wire disconnect release owned route",()=>
{
    var p=new Fake();using var s=p.Service();Send(s,"acquire",AcquireArgs(p));var ended=s.Disconnect("OWNER_CHANNEL_EOF");
    Check(ended.Ok&&ended.ExactOriginalRolesRestored&&s.Closed,"EOF did not release");Restored(p);
    try {WireInput.ReadLine(new StringReader("unterminated"),100,CancellationToken.None).GetAwaiter().GetResult();throw new Exception("Truncated accepted");}catch(InvalidDataException){}
    try {WireInput.ReadLine(new StringReader("abcd\n"),3,CancellationToken.None).GetAwaiter().GetResult();throw new Exception("Overlimit accepted");}catch(InvalidDataException){}
});
Run("terminal receipt failure never reports release success",()=>
{
    var p=new Fake{TerminalFails=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    var done=Send(s,"release",Key(r));Check(!done.Ok&&!done.ExactOriginalRolesRestored&&s.HasLease,"Unverified terminal marked restored");Restored(p);
});
Run("communications drift is detected despite zero communications setters",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));p.Values[2]="external-communications";
    var done=Send(s,"release",Key(r));Check(!done.Ok&&p.Values[2]=="external-communications"&&p.Writes.All(x=>x.Role!=RenderRole.Communications),"Communications overwritten or falsely verified");
});
Run("active source prevents default restoration on EOF",()=>
{
    var p=new Fake();using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));Send(s,"armCaptureInterval",Key(r));Send(s,"authorizeResume",ResumeArgs(r));p.Paused=false;
    var ended=s.Disconnect("OWNER_CHANNEL_EOF");Check(!ended.Ok&&!ended.ExactOriginalRolesRestored&&ended.State=="recoveryRequired"&&p.Writes.Count==2,"Active source restored to Default");
});
Run("numeric wire IDs echo and malformed envelopes close with owned cleanup",()=>
{
    var p=new Fake();using var s=p.Service();var hello=s.Dispatch("{\"id\":1,\"command\":\"hello\",\"payload\":{}}");
    Check(hello.Ok&&hello.Id is long value&&value==1,"Numeric ID rejected");Send(s,"acquire",AcquireArgs(p));
    var bad=s.Dispatch("{\"id\":2,\"id\":3,\"command\":\"status\"}");Check(s.Closed&&bad.ExactOriginalRolesRestored,"Malformed envelope did not release");Restored(p);
});
Run("parent authority loss after first write still permits valid owned rollback",()=>
{
    var p=new Fake{LoseParentAfterWrite=true};using var s=p.Service();var r=Send(s,"acquire",AcquireArgs(p));
    Check(!r.Ready&&p.Writes.Count==2,"Parent loss prevented owned rollback or allowed second apply");Restored(p);
});
Run("EOF after parent loss can compensate from retained ownership when paused",()=>
{
    var p=new Fake();using var s=p.Service();Send(s,"acquire",AcquireArgs(p));p.ParentLost=true;
    var done=s.Disconnect("OWNER_CHANNEL_EOF");Check(done.ExactOriginalRolesRestored&&p.Writes.Count==4,"Parent loss blocked safe EOF compensation");Restored(p);
});
Run("fresh official pause is bracketed around complete native proof",()=>
{
    var p=new Fake();var control=new SourceFake(p);var verifier=new SourcePauseVerifier(control,p,p,()=>p.Now);
    verifier.RequirePaused(new("official-device","spotify:track:owned",p.Live));
    Check(control.Reads==2&&p.Observations==1&&control.Pauses==0,"Pause proof lacked independent brackets");
});
Run("recovery pause only controls exact owned device and track",()=>
{
    var p=new Fake();var control=new SourceFake(p){Playing=true};var verifier=new SourcePauseVerifier(control,p,p,()=>p.Now);
    verifier.PauseOwnedForRecovery(new("official-device","spotify:track:owned",p.Live));
    Check(control.Pauses==1&&control.Reads==3,"Exact owned recovery pause did not confirm");
    foreach(var external in new[]{"track","device"})
    {
        var c=new SourceFake(p){Playing=true,Track=external=="track"?"spotify:track:external":"spotify:track:owned",Device=external=="device"?"other-device":"official-device"};
        try {new SourcePauseVerifier(c,p,p,()=>p.Now).PauseOwnedForRecovery(new("official-device","spotify:track:owned",p.Live));throw new Exception("External source accepted");}catch(RouteBlockedException){}
        Check(c.Pauses==0,"External source paused");
    }
});
Run("partial or active native sessions invalidate official paused status",()=>
{
    foreach(var incomplete in new[]{true,false})
    {
        var p=new Fake{Complete=!incomplete,Paused=incomplete};var c=new SourceFake(p);
        try {new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live));throw new Exception("Unproved native pause accepted");}catch(RouteBlockedException){}
    }
});
Run("process capture pause does not depend on endpoint Active flags or a full scan",()=>
{
    foreach(var complete in new[]{true,false})
    {
        var p=new Fake{Complete=complete,Paused=false};var c=new SourceFake(p);
        new SourcePauseVerifier(c,p,p,()=>p.Now,requireNativeQuiescence:false)
            .RequirePaused(new("official-device","spotify:track:owned",p.Live,RequirePcmStopped:true));
        Check(p.Observations==0,"Process pause unnecessarily scanned endpoint sessions");
        Check(c.Reads==2,"Process pause must freshly confirm both source reads");
    }
});
Run("process capture still rejects playing stale wrong-track wrong-device and unstopped PCM",()=>
{
    foreach(var reason in new[]{"playing","stale","track","device","pcm","resumed"})
    {
        var p=new Fake();var c=new SourceFake(p){Playing=reason=="playing",Stale=reason=="stale",
            Track=reason=="track"?"spotify:track:external":"spotify:track:owned",Device=reason=="device"?"other":"official-device",
            PcmStopped=reason!="pcm",ResumeOnSecondRead=reason=="resumed"};
        try {new SourcePauseVerifier(c,p,p,()=>p.Now,requireNativeQuiescence:false)
            .RequirePaused(new("official-device","spotify:track:owned",p.Live,RequirePcmStopped:true));
            throw new Exception("Invalid process source accepted: "+reason);}catch(RouteBlockedException){}
    }
});
Run("process capture resume refreshes its capture baseline without requiring inactive render sessions",()=>
{
    var p=new Fake{Paused=false};var c=new SourceFake(p);
    new SourcePauseVerifier(c,p,p,()=>p.Now,requireNativeQuiescence:false,observeCaptureBaseline:true)
        .RequirePaused(new("official-device","spotify:track:owned",p.Live));
    Check(p.Observations==1&&c.Reads==2,"Resume did not publish one fresh capture baseline");
    p.Complete=false;
    try {new SourcePauseVerifier(c,p,p,()=>p.Now,requireNativeQuiescence:false,observeCaptureBaseline:true)
        .RequirePaused(new("official-device","spotify:track:owned",p.Live));throw new Exception("Incomplete capture baseline accepted");}
    catch(RouteBlockedException e){Check(e.Message=="PAUSED_SOURCE_SCAN_INCOMPLETE","Baseline cause lost");}
});
Run("legacy incomplete scan returns its specific pause cause",()=>
{
    var p=new Fake{Complete=false};var c=new SourceFake(p);
    try {new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live));
        throw new Exception("Incomplete scan accepted");}
    catch(RouteBlockedException e) {Check(e.Message=="PAUSED_SOURCE_SCAN_INCOMPLETE","Pause cause lost");}
});
Run("external resume during native proof prevents restoration",()=>
{
    var p=new Fake();var c=new SourceFake(p){ResumeOnSecondRead=true};
    try {new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live));throw new Exception("External resume ignored");}catch(RouteBlockedException){}
});
Run("cancel before select may restore a still-paused previous owned track",()=>
{
    var p=new Fake();var c=new SourceFake(p){Track="spotify:track:baseline"};
    new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live,"spotify:track:baseline",true));
    c.Playing=true;
    try {new SourcePauseVerifier(c,p,p,()=>p.Now).PauseOwnedForRecovery(new("official-device","spotify:track:owned",p.Live,"spotify:track:baseline",true));throw new Exception("Previous active track paused");}catch(RouteBlockedException){}
    Check(c.Pauses==0,"Previous active track changed");
});
Run("stale official source status cannot prove pause",()=>
{
    var p=new Fake();var c=new SourceFake(p){Stale=true};
    try {new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live));throw new Exception("Stale source accepted");}catch(RouteBlockedException){}
    Check(p.Observations==0,"Stale source triggered native proof");
});
Run("trial capability never becomes production qualified",()=>
{
    var capabilities=Fake.Qualified with{ProductionQualified=false,TrialAuthorized=true};
    Check(capabilities.CanOperate&&!capabilities.Supported&&!capabilities.ProductionQualified,"Trial promoted to production");
});
Run("OS default drift still restores exact null without any global write",()=>
{
    var p=new Fake();using var s=p.Service();var lease=Send(s,"acquire",AcquireArgs(p));p.DefaultsChanged=true;
    var result=Send(s,"release",Key(lease));
    Check(result.Ok&&result.ExactOriginalRolesRestored&&!result.DefaultsUnchanged&&result.ObservedDefaultsChanged==true&&!result.GlobalDefaultsWritten,"Default drift blocked exact restoration or fabricated global write");
    Check(result.Defaults?.Current[0]=="LGTV","Current default resolution lost");Restored(p);
});
Run("fresh complete snapshot cannot clear contaminated capture interval",()=>
{
    var p=new Fake();using var s=p.Service();var lease=Send(s,"acquire",AcquireArgs(p));Send(s,"armCaptureInterval",Key(lease));Send(s,"authorizeResume",ResumeArgs(lease));p.Paused=false;p.IntervalIsolated=false;
    var status=Send(s,"status",Key(lease));Check(!status.Ok&&!status.Ready&&!status.IntervalIsolated&&status.Code=="CAPTURE_INTERVAL_ISOLATION_LOST","Current snapshot promoted contaminated history");
    p.Paused=true;Check(Send(s,"release",Key(lease)).ExactOriginalRolesRestored,"Interval contamination blocked owned policy cleanup");
});
Run("source proof failure before Prepared is a clean no-policy rejection",()=>
{
    var p=new Fake{SourceProofFails=true};using var s=p.Service();var result=Send(s,"acquire",AcquireArgs(p));
    Check(!result.Ok&&p.Writes.Count==0&&p.ReadLatest() is null,"Pre-Prepared source failure wrote policy");
    var close=Send(s,"close");Check(close.Ok&&close.Code=="NO_POLICY_WRITES"&&!close.ExactOriginalRolesRestored,"Source failure became journal uncertainty");
});
Run("capture interval arms once after held acquisition and cannot reset",()=>
{
    var p=new Fake();using var s=p.Service();var lease=Send(s,"acquire",AcquireArgs(p));
    Check(lease.Ok&&!lease.IntervalArmed&&lease.IntervalId is null,"Acquisition pre-armed format-probe history");
    var armed=Send(s,"armCaptureInterval",Key(lease));Check(armed.Ok&&armed.IntervalArmed&&armed.IntervalGeneration==1&&armed.IntervalIsolated,"Capture fence not armed");
    var id=armed.IntervalId;p.IntervalIsolated=false;
    var second=Send(s,"armCaptureInterval",Key(lease));Check(!second.Ok&&second.IntervalId==id&&!second.IntervalIsolated,"Contaminated interval reset");
});
Run("compensation requires true PCM-stop proof on both source reads",()=>
{
    var p=new Fake();var c=new SourceFake(p){PcmStopped=false};
    try {new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live,RequirePcmStopped:true));throw new Exception("Missing stop proof accepted");}catch(RouteBlockedException e)when(e.Message=="PCM_STOP_NOT_CONFIRMED"){}
    c.PcmStopped=true;new SourcePauseVerifier(c,p,p,()=>p.Now).RequirePaused(new("official-device","spotify:track:owned",p.Live,RequirePcmStopped:true));
});
foreach(var originals in new string?[][] { [null,"Opaque-Explicit-USB"], ["Opaque-Explicit-HDMI","Opaque-Explicit-USB"] })
Run("safe explicit and null policy originals remain exact through service",()=>
{
    var p=new Fake();p.Values[0]=p.Originals[0]=originals[0];p.Values[1]=p.Originals[1]=originals[1];
    using var service=p.Service();
    var inspect=Send(service,"inspect",new{captureDeviceId="BASE-capture",renderDeviceId="BASE-render"});
    var inspection=JsonSerializer.SerializeToElement(inspect.Inspection);
    Check(inspect.Ok&&inspection.GetProperty("originalPolicySafe").GetBoolean()&&!inspection.GetProperty("sourceOutputDefault").GetBoolean(),"Explicit policy was labeled Default or rejected");
    var held=Send(service,"acquire",AcquireArgs(p));Check(held.Ok,"Safe mixed originals rejected");
    var ended=Send(service,"release",Key(held));Check(ended.Ok&&ended.ExactOriginalRolesRestored,"Exact explicit release failed");Restored(p);
    Check(p.ReadLatest()!.Roles.Take(2).Select(x=>x.Original).SequenceEqual(originals),"Raw policy changed in journal");
});
Run("unproven original policy cannot reach Prepared or any setter",()=>
{
    var p=new Fake{PolicySafe=false};p.Values[0]="unknown-route";using var service=p.Service();
    var response=Send(service,"acquire",AcquireArgs(p));Check(!response.Ok&&p.Writes.Count==0&&p.ReadLatest() is null,"Unsafe original policy was adopted");
});
Run("safe explicit originals cannot bypass another writer blocker",()=>
{
    var p=new Fake{NoOtherWriters=false};p.Values[0]=p.Originals[0]="safe-explicit-physical";using var service=p.Service();
    var response=Send(service,"acquire",AcquireArgs(p));Check(!response.Ok&&p.Writes.Count==0&&p.Values[0]==p.Originals[0],"Explicit-original support bypassed isolation");
});
Run("failed acquire compensates mixed originals and retains exact receipt",()=>
{
    var p=new Fake{ThrowAfterFirstWrite=true};p.Values[0]=p.Originals[0]="MiXeD-Raw-Explicit-USB";
    using var service=p.Service();var failed=Send(service,"acquire",AcquireArgs(p));
    Check(!failed.Ready&&Lease(failed).GetProperty("originalRoles")[0].GetProperty("original").GetString()==p.Originals[0],"Failed acquisition receipt changed original");
    var restored=Send(service,"release",Key(failed));Check(restored.Ok&&restored.ExactOriginalRolesRestored,"Failed acquisition compensation not terminal");Restored(p);
});
passed+=PhysicalOwnerDiagnosticTests.Run();
Console.WriteLine($"PASS {passed} product service tests (device-free; no Windows execution)");

sealed class Fake:IProductRouteBackend,IProductRouteLifetime,IVerifiedSpotifyResolver,ISelectedEndpointVerifier,ISessionObserver,IDurableRouteJournal
{
    public static ProductCapabilities Qualified=new(true,true,true,true,true,[],IntervalIsolation:true);
    public ProductCapabilities Capabilities {get;set;}=Qualified;
    public SpotifyProcess Live=new(1234,new DateTime(2026,10,9,0,0,0,DateTimeKind.Utc).Ticks,"S-test","spotify-policy","verified-image","desktop");
    public BaseRenderEndpoint Endpoint=new("BASE-render","base-policy","trusted-owner","trusted-driver",true,true,true);
    public readonly string?[] Originals=[null,null,"communications-original"];
    public string?[] Values=[null,null,"communications-original"];
    public DateTimeOffset Now=new(2026,10,9,0,0,0,TimeSpan.Zero);
    public bool Paused=true,Complete=true,ChangeBeforePrepare,ThrowAfterFirstWrite,FailAppliedCommit,LoseOwnershipAfterWrite,TerminalFails;
    public string? ReceiptFault;
    public int Inspects,Observations;
    public bool OwnershipLost,Disposed,ParentLost,LoseParentAfterWrite,DefaultsChanged,SourceProofFails;
    public bool PolicySafe=true;
    public bool NoOtherWriters=true;
    public bool IntervalIsolated {get;set;}=true;
    public int IntervalGeneration {get;private set;}
    public string? IntervalId {get;private set;}
    public void ArmCaptureInterval(string session,int generation){IntervalGeneration=generation;IntervalId=Guid.NewGuid().ToString("D");}
    public List<string> Trace=[];
    public List<(RenderRole Role,string? Value)> Writes=[];
    private RouteRecord? record;
    private ProductDiscovery? opened;
    public ProductRouteService Service()=>new(this,()=>Now,()=>Now-new DateTimeOffset(2026,10,9,0,0,0,TimeSpan.Zero));
    public ProductDiscovery Inspect(RouteSelection selection)
    {
        Inspects++;
        return new(Live,Endpoint,selection,Values.ToArray(),Paused,Values.Take(2).All(value=>value is null),true,true,NoOtherWriters,OriginalPolicySafe:PolicySafe);
    }
    public IProductRouteLifetime Open(ProductDiscovery d) {opened=d;return this;}
    public IVerifiedSpotifyResolver Resolver=>this;
    public ISelectedEndpointVerifier EndpointVerifier=>this;
    public ISessionObserver Observer=>this;
    public IDurableRouteJournal Journal=>this;
    public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord prepared)
    {
        Trace.Add("ack");return new(ReceiptFault=="transaction"?Guid.NewGuid():prepared.TransactionId,prepared.CurrentProcess,
            new string('a',64),1024,"held-file-id",ReceiptFault!="root",ReceiptFault!="retained",ReceiptFault!="ack");
    }
    public void ValidateApplyAuthority() {if(ParentLost)throw new RouteBlockedException("PARENT_APPLY_AUTHORITY_LOST");}
    public void ValidateOwnership(PreparedRetention proof)
    {if(OwnershipLost)throw new JournalUnavailableException("RETAINED_OWNERSHIP_LOST");}
    public void VerifyPausedSource(OwnedPlaybackTarget d)
    {
        if(SourceProofFails)throw new RouteBlockedException("SOURCE_BROKER_UNAVAILABLE");
        if(!Paused||d.Process!=Live)throw new RouteBlockedException("SOURCE_NOT_PAUSED_OR_CHANGED");
        if(ChangeBeforePrepare) Values[0]="external-before-prepare";
    }
    public ProductDefaultStatus ReadDefaultStatus()=>new(!DefaultsChanged,["XingCore","XingCore","old","mic","mic","mic"],DefaultsChanged?["LGTV","LGTV","old","other-mic","mic","mic"]:["XingCore","XingCore","old","mic","mic","mic"]);
    public void VerifyRestoredTerminal(RouteRecord terminal,PreparedRetention proof)
    {
        if(TerminalFails || terminal.TransactionId!=proof.TransactionId || terminal.Stage is not (RouteStage.Restored or RouteStage.RolledBack) ||
            !terminal.Roles.Select(x=>x.Original).SequenceEqual(Values)) throw new RouteBlockedException("TERMINAL_FULL_READBACK_MISMATCH");
    }
    public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected)
    {if(expected!=Live)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");return new Bound(this,expected);}
    public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected)=>Endpoint;
    public SessionObservation Observe(IBoundSpotifyPolicy process,TimeSpan maximumWait)
    {
        Observations++;var transient=TransientActiveScans>0;if(transient)TransientActiveScans--;
        return new(Complete,process.Identity,Now,Paused&&!transient?[]:[new(process.Identity,"session-1",Endpoint.Id,true)]);
    }
    public int TransientActiveScans;
    public RouteRecord? ReadLatest()=>record;
    public void Append(RouteRecord value)
    {
        if(FailAppliedCommit&&value.Roles.Any(r=>r.Stage==RoleStage.Applied))throw new IOException("SIMULATED_JOURNAL_FAILURE");
        record=value;Trace.Add("journal:"+value.Stage);
    }
    public void Dispose()=>Disposed=true;
    private sealed class Bound(Fake owner,SpotifyProcess identity):IBoundSpotifyPolicy
    {
        public SpotifyProcess Identity=>identity;
        public SpotifyProcess CheckLiveIdentity()=>owner.Live;
        public string? Get(RenderRole role)=>owner.Values[(int)role];
        public void Set(RenderRole role,string? endpoint)
        {
            if(owner.Live!=identity)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
            owner.Trace.Add("set:"+role+":"+endpoint);owner.Writes.Add((role,endpoint));owner.Values[(int)role]=endpoint;
            if(owner.LoseOwnershipAfterWrite)owner.OwnershipLost=true;
            if(owner.LoseParentAfterWrite)owner.ParentLost=true;
            if(owner.ThrowAfterFirstWrite&&owner.Writes.Count==1)throw new IOException("SET_THROW_AFTER_MUTATION");
        }
        public void Dispose(){}
    }
}

sealed class SourceFake(Fake platform):ISourcePlaybackControl
{
    public bool Playing,ResumeOnSecondRead,Stale;
    public bool PcmStopped=true;
    public string Device="official-device",Track="spotify:track:owned";
    public int Reads,Pauses;
    public PlaybackStatus ReadFresh(TimeSpan budget)
    {
        Reads++;if(ResumeOnSecondRead&&Reads==2)Playing=true;
        return new(Device,Track,Playing,Stale?platform.Now-TimeSpan.FromSeconds(1):platform.Now,PcmStopped);
    }
    public void PauseExactDevice(string deviceId,TimeSpan budget)
    {if(deviceId!=Device)throw new Exception("Wrong device");Pauses++;Playing=false;platform.Paused=true;}
}
