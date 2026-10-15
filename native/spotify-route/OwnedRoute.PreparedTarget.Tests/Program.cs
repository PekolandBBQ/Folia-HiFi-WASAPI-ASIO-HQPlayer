using Folia.ProductRoute;
using Folia.RouteResearch;

// Only the pure transaction/service assembly is used. No Windows helper, API, device or account is accessed.
int count=0;
void Check(bool value,string reason){if(!value)throw new Exception(reason);}
void Test(string name,Action action){action();count++;Console.WriteLine("PASS "+name);}
void Ok(ServiceReply r)=>Check(r.Ok,r.Code);
ServiceReply Witness(Fixture f)=>f.Send("verifyPreparedTargetActive",new{selectedSourceUri=Fixture.Track});

Test("interrupted selection parks without inventing target activity or changing original routes",()=>{
 using var f=new Fixture();f.BeginPreparation();var writes=f.Writes;
 f.Paused=true;f.PcmStopped=true;f.ResetReceipt();
 var held=f.Send("suspendPaused",new{intervalEpoch=1});Ok(held);
 Check(held.State=="pausedHeld"&&!held.Ready&&!held.IntervalArmed&&f.Writes==writes,"Recovery changed policy or admitted PCM");
 Check(!f.Send("armCaptureInterval").Ok,"Recovery invented activity witness");
 Ok(f.Send("release"));f.CheckOriginals();
});
Test("capture child exit does not prevent verified pause cleanup and a fresh preparation on the retained route",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);var writes=f.Writes;
 f.CaptureChildExited=true;f.Paused=true;f.PcmStopped=true;f.ResetReceipt();
 Ok(f.Send("suspendPaused",new{intervalEpoch=1}));
 Check(f.Writes==writes&&f.Service.HasLease,"Cleanup rewrote original policy or dropped ownership");
 f.CaptureChildExited=false;f.Epoch=2;f.ResetReceipt();
 Ok(f.Send("resumePreparation",new{intervalEpoch=2,selectedSourceUri=Fixture.Track}));
 Ok(f.Send("completePreparedSelection"));f.Start(2);
 Check(f.Send("status").Ready,"Fresh capture did not recover");
});

Test("preparation cannot complete from a paused empty scan without prior target activity",()=>{
 using var f=new Fixture();f.BeginPreparation();f.AlterObservation=o=>o with{Sessions=[]};
 var r=f.Send("completePreparedSelection");Check(!r.Ok&&r.Code=="PREPARED_TARGET_ACTIVITY_REQUIRED"&&!r.Ready&&!r.IntervalArmed,"Unwitnessed preparation completed");
 Check(!f.Send("armCaptureInterval").Ok,"Capture admitted before witness");
});
Test("active witness has no policy writes, journal transition, source GET, capture interval or readiness",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;var writes=f.Writes;var revision=f.Latest!.Revision;var reads=f.SourceReads;
 var r=Witness(f);Ok(r);Check(r.PreparedTargetActive&&!r.Ready&&!r.ResumeAuthorized&&!r.IntervalArmed&&r.State=="preparedSelection","Witness published authority");
 Check(f.Writes==writes&&f.Latest.Revision==revision&&f.SourceReads==reads,"Read-only fence mutated policy or added a source GET");
 Check(f.Latest.Stage==RouteStage.HeldPaused,"Preparation changed active transaction state");
 f.Paused=true;f.ResetReceipt();Ok(f.Send("completePreparedSelection"));
 Check(!f.Send("completePreparedSelection").Ok,"Witness replay completed preparation twice");
});
Test("complete empty, wrong-endpoint and mixed migration samples wait before target activity",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;int scans=0;
 f.AlterObservation=o=>++scans switch {1=>o with{Sessions=[]},2=>o with{Sessions=[new(Fixture.Identity,"old","physical",true)]},3=>o with{Sessions=[..o.Sessions,new(Fixture.Identity,"old","physical",true)]},_=>o};
 Ok(Witness(f));Check(scans==4,"Did not wait for exclusive target activity");
});
Test("inactive and expired historical rows elsewhere do not reject current target activity",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;
 f.AlterObservation=o=>o with{Sessions=[..o.Sessions,new(Fixture.Identity,"old","physical",false)]};Ok(Witness(f));
});
Test("slow admission does not expire a session observation that has not happened yet",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;int checks=0;
 f.OnValidateAuthority=()=>{if(++checks==1)Thread.Sleep(2100);};
 var scans=f.SessionScans;Ok(Witness(f));
 Check(checks==2&&f.SessionScans==scans+1,"Repeated admission or native observation after fresh evidence");
});
Test("evidence that actually ages during final ownership confirmation still expires",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;int checks=0;
 f.OnValidateAuthority=()=>{if(++checks==2)f.Advance(TimeSpan.FromSeconds(3));};
 var result=Witness(f);Check(!result.Ok&&result.Code=="PREPARED_TARGET_ACTIVITY_EXPIRED","Stale session evidence accepted");
});
Test("incomplete evidence fails immediately and retains owned cleanup",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;int scans=0;f.AlterObservation=o=>{scans++;return o with{CompleteForProcess=false};};
 var r=Witness(f);Check(!r.Ok&&r.Code=="SESSION_OBSERVATION_UNTRUSTED"&&scans==1&&f.Service.HasLease&&!r.Ready,"Incomplete evidence retried or lost ownership");
 f.AlterObservation=null;f.Paused=true;f.ResetReceipt();Ok(f.Send("release"));f.CheckOriginals();
});
Test("missing activity reaches one bounded deadline without additional policy or source writes",()=>{
 using var f=new Fixture();f.BeginPreparation();var writes=f.Writes;var reads=f.SourceReads;
 f.AlterObservation=o=>o with{Sessions=[]};var timer=System.Diagnostics.Stopwatch.StartNew();var r=Witness(f);
 Check(!r.Ok&&r.Code=="SPOTIFY_ACTIVE_SESSION_NOT_ON_TARGET"&&timer.Elapsed<TimeSpan.FromSeconds(3),"Missing stream was accepted or deadline renewed");
 Check(f.Writes==writes&&f.SourceReads==reads&&f.Service.HasLease&&!r.Ready,"Failure changed authority");
});
Test("wrong URI, lease generation or preparation epoch cannot publish a witness",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;
 foreach(var extra in new[]{new{selectedSourceUri=Fixture.Other,generation=1,intervalEpoch=1},new{selectedSourceUri=Fixture.Track,generation=2,intervalEpoch=1},new{selectedSourceUri=Fixture.Track,generation=1,intervalEpoch=2}})
  Check(!f.Send("verifyPreparedTargetActive",extra).Ok,"Unbound witness accepted");
 Check(!f.Send("completePreparedSelection").Ok,"Rejected witness leaked");
});
Test("process change during native scan cannot publish or complete a witness",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;f.AlterObservation=o=>{f.Live=Fixture.Identity with{StartTimeUtcTicks=Fixture.Identity.StartTimeUtcTicks+1};return o;};
 var r=Witness(f);Check(!r.Ok&&!r.Ready&&r.Code=="SPOTIFY_INSTANCE_CHANGED","Process change accepted");
});
Test("external policy change during native scan cannot publish a witness",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;f.AlterObservation=o=>{f.Set(RenderRole.Console,"external");return o;};
 var r=Witness(f);Check(!r.Ok&&!r.Ready&&r.Code=="EXTERNAL_POLICY_CONFLICT","External policy accepted");
});
Test("a witness cannot complete while the selected source remains running",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;Ok(Witness(f));f.ResetReceipt();
 var r=f.Send("completePreparedSelection");Check(!r.Ok&&!r.Ready,"Playing source completed");
 // The failed selected-source receipt invalidates pending authority; re-observe
 // activity before a new paused fence rather than salvaging the failed receipt.
 f.Paused=false;Ok(Witness(f));f.Paused=true;f.ResetReceipt();Ok(f.Send("completePreparedSelection"));
});
Test("same-owner same-track held resume rebinds actual history after fresh pause proof",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();var scans=f.SessionScans;f.Epoch=2;
 var resume=f.Send("resumePreparation",new{intervalEpoch=2,selectedSourceUri=Fixture.Track});Ok(resume);
 Check(resume.PreparedTargetActive&&f.SessionScans>scans&&!resume.Ready&&!resume.IntervalArmed,"Resume invented fresh activity or skipped pause proof");
 Check(!f.Send("completePreparedSelection",new{intervalEpoch=1}).Ok,"Prior epoch completion accepted");
 Ok(f.Send("completePreparedSelection"));f.Start(2);Check(f.Send("status").Ready,"Exact resumed owner failed");
});
Test("source change invalidates activity history even when the same source later returns",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;Ok(Witness(f));
 f.Paused=true;f.TrackUri=Fixture.Other;f.ResetReceipt();Check(!f.Send("completePreparedSelection").Ok,"Changed source completed");
 f.TrackUri=Fixture.Track;f.ResetReceipt();var r=f.Send("completePreparedSelection");
 Check(!r.Ok&&r.Code=="PREPARED_TARGET_ACTIVITY_REQUIRED","Source change retained old activity authority");
});
Test("a failed restoration attempt invalidates activity history while retaining cleanup ownership",()=>{
 using var f=new Fixture();f.BeginPreparation();f.Paused=false;Ok(Witness(f));var release=f.Send("release");
 Check(!release.Ok&&f.Service.HasLease,"Playing source restore lost owner");
 f.Paused=true;f.ResetReceipt();var r=f.Send("completePreparedSelection");
 Check(!r.Ok&&r.Code=="PREPARED_TARGET_ACTIVITY_REQUIRED","Failed release retained preparation witness");
 Ok(f.Send("release"));f.CheckOriginals();
});
Console.WriteLine($"PASS {count} prepared-target tests; no Windows/audio execution.");
