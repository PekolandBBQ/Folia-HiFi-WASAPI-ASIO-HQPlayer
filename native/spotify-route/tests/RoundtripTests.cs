using Folia.RouteRunner;
using Folia.RouteResearch;

internal static class RoundtripTests
{
    internal static int Run()
    {
        var passed=0;
        void Test(string name,Action action) { action(); passed++; Console.WriteLine("PASS A4 "+name); }
        void Require(bool yes) { if(!yes) throw new Exception("A4 assertion failed"); }
        void Block(Action action,string? code=null)
        {
            try { action(); }
            catch(RouteBlockedException e) { if(code!=null) Require(e.Message==code); return; }
            throw new Exception("Expected A4 blocker");
        }
        var process=new SpotifyProcess(123,456,"sid","policy","image","desktop");
        NativeSession Row(string endpoint="original",int state=1)=>new(123,"session",endpoint,state,0,1);
        var frozen=FrozenOriginals.Read([null,"policy-original","communication"],_=>"original",p=>p=="policy-original"?"original":null);
        Test("null and custom originals retained without normalizing",()=>Require(frozen.Values[0]==null && frozen.Values[1]=="policy-original" && frozen.Endpoints.SequenceEqual(new[]{"original","original"})));
        Test("empty original is distinct from null and blocked",()=>Block(()=>FrozenOriginals.Read(["",null,null],_=>"original",_=>"original")));
        Test("unmapped original cannot fall back to default",()=>Block(()=>FrozenOriginals.Read(["unmapped",null,null],_=>"original",_=>null)));
        Test("default change cannot redefine frozen return endpoint",()=>Block(()=>frozen.Check(frozen.Values,_=>"new-default",_=>"original"),"FROZEN_ORIGINAL_ENDPOINT_CHANGED"));
        Test("communications raw policy change is not ignored",()=>Block(()=>frozen.Check([null,"policy-original","new-communications"],_=>"original",_=>"original"),"FROZEN_ORIGINAL_POLICY_CHANGED"));
        Test("no selected session stays unqualified",()=>Require(!BoundedPrepare.ActiveOriginalOnly(process,[],frozen,"target")));
        Test("inactive old target row is kept but not entry evidence",()=>Require(BoundedPrepare.ActiveOriginalOnly(process,[Row(),Row("target",0)],frozen,"target")));
        Test("inactive original never qualifies preparation",()=>Require(!BoundedPrepare.ActiveOriginalOnly(process,[Row(state:0)],frozen,"target")));
        Test("active target cannot become original baseline",()=>Block(()=>BoundedPrepare.ActiveOriginalOnly(process,[Row("target")],frozen,"target")));
        Test("mixed active original and third endpoint blocks",()=>Block(()=>BoundedPrepare.ActiveOriginalOnly(process,[Row(),Row("third")],frozen,"target")));
        Test("positive system-sounds row alone can be excluded",()=>SessionIdentity.RequireUnambiguousForApply([Row(),new(0,"system","target",1,SessionIdentity.NoSingleProcess,0)]));
        Test("cross-process non-system row still blocks",()=>Block(()=>SessionIdentity.RequireUnambiguousForApply([Row(),new(123,"cross","target",1,SessionIdentity.NoSingleProcess,1)])));
        Test("unknown system classifier cannot qualify Spotify",()=>Block(()=>SessionIdentity.RequireUnambiguousForApply([Row() with {SystemSoundsHResult=null}])));
        Test("failed system classifier remains unknown",()=>Block(()=>SessionIdentity.RequireUnambiguousForApply([Row() with {SystemSoundsHResult=unchecked((int)0x80004005u)}])));
        Test("PID zero non-system row remains unknown",()=>Block(()=>SessionIdentity.RequireUnambiguousForApply([new(0,"zero","original",1,0,1)])));
        Test("positive system row never becomes Spotify target fact",()=>Require(SnapshotFacts.ForProcess(process,[Row("target") with {SystemSoundsHResult=0}]).Sessions.Length==0));
        Test("unknown system row never becomes Spotify target fact",()=>Require(SnapshotFacts.ForProcess(process,[Row("target") with {SystemSoundsHResult=null}]).Sessions.Length==0));
        Test("another active name candidate blocks rather than auto-adopts",()=>Block(()=>BoundedPrepare.RequireNoOtherSpotify([Row() with {ReportedProcessId=124}],123,[123,124])));
        Test("unrelated independently reported app is not relabelled Spotify",()=>BoundedPrepare.RequireNoOtherSpotify([Row() with {ReportedProcessId=124}],123,[123]));
        Test("identity changed before scan rejects without scanning",()=>
        {
            var scans=0;
            Block(()=>BoundedPrepare.BracketedSnapshot(process,()=>process with {StartTimeUtcTicks=457},()=>{scans++;return [Row()];},()=>false,()=>0,65_000));
            Require(scans==0);
        });
        Test("identity changed after scan rejects sampled ownership",()=>
        {
            var checks=0;
            Block(()=>BoundedPrepare.BracketedSnapshot(process,()=>++checks==1?process:process with {ImageIdentity="replaced"},()=>[Row()],()=>false,()=>0,65_000));
        });
        Test("slow scan cannot qualify fresh preparation",()=>
        {
            long elapsed=0;
            Block(()=>BoundedPrepare.BracketedSnapshot(process,()=>process,()=>{elapsed=1_001;return [Row()];},()=>false,()=>elapsed,65_000),"PREPARE_LATE_SNAPSHOT_REJECTED");
        });
        Test("scan completing at prepare deadline is rejected",()=>
        {
            long elapsed=64_500;
            Block(()=>BoundedPrepare.BracketedSnapshot(process,()=>process,()=>{elapsed=65_000;return [Row()];},()=>false,()=>elapsed,65_000));
        });
        Test("cancelled prepare performs no scan",()=>
        {
            var scans=0;
            Block(()=>BoundedPrepare.Wait(process,frozen,"target",()=>{scans++;return [Row()];},()=>process,()=>{},()=>[123],()=>true,()=>0,_=>{}));
            Require(scans==0);
        });
        Test("empty then inactive then active prepare is readonly and partial",()=>
        {
            long elapsed=0;var scans=0;
            var sample=BoundedPrepare.Wait(process,frozen,"target",()=>++scans switch {1=>[],2=>[Row(state:0)],_=>[Row(),Row("target",0)]},()=>process,()=>{},()=>[123],()=>false,()=>elapsed,ms=>elapsed+=ms);
            Require(scans==3 && elapsed==200 && sample.Rows.Length==2 && !sample.Observation.CompleteForProcess);
        });
        Test("no-active prepare times out without extending its origin",()=>
        {
            long elapsed=0;
            Block(()=>BoundedPrepare.Wait(process,frozen,"target",()=>[],()=>process,()=>{},()=>[123],()=>false,()=>elapsed,ms=>elapsed+=ms));
            Require(elapsed==65_000);
        });
        Test("post-snapshot checks cannot age successful prepare silently",()=>
        {
            long elapsed=0;var checks=0;
            Block(()=>BoundedPrepare.Wait(process,frozen,"target",()=>[Row()],()=>process,()=>{if(++checks==2)elapsed=1_001;},()=>[123],()=>false,()=>elapsed,ms=>elapsed+=ms),"PREPARE_SAMPLE_BECAME_STALE");
        });
        Test("role0 transition to target permits remaining role1 apply",()=>BoundedPrepare.RequireTransitionEndpoints(process,[Row("target")],frozen,"target"));
        Test("transitional third endpoint is blocked",()=>Block(()=>BoundedPrepare.RequireTransitionEndpoints(process,[Row("third")],frozen,"target")));
        var target=new BaseRenderEndpoint("target","target-policy","owner","driver",true,true,true);
        var record=new RouteRecord(1,1,Guid.NewGuid(),process,process,target,RouteStage.Applying,
            [new(RenderRole.Console,null,RoleStage.Applied),new(RenderRole.Multimedia,"policy-original",RoleStage.ApplyIntent),new(RenderRole.Communications,"communication",RoleStage.Untouched)],null,DateTimeOffset.UtcNow);
        Test("pending second role expects original while first expects target",()=>BoundedPrepare.RequirePreparedPolicyValues(record,frozen,["target-policy","policy-original","communication"]));
        Test("core cannot adopt different originals after prepare",()=>Block(()=>BoundedPrepare.RequirePreparedPolicyValues(record with {Roles=record.Roles.Select(x=>x.Role==RenderRole.Communications?x with {Original="changed"}:x).ToArray()},frozen,["target-policy","policy-original","communication"])));
        Test("preapply reread catches untouched communications drift",()=>Block(()=>BoundedPrepare.RequirePreparedPolicyValues(record,frozen,["target-policy","policy-original","changed"])));
        Test("preapply reread catches already applied role drift",()=>Block(()=>BoundedPrepare.RequirePreparedPolicyValues(record,frozen,["external","policy-original","communication"])));
        Test("automatic recovery requires exact creation ticks",()=>Block(()=>Worker.RequireAutomaticRecoveryIdentity(process with {StartTimeUtcTicks=457},process)));
        Test("automatic recovery requires exact image identity",()=>Block(()=>Worker.RequireAutomaticRecoveryIdentity(process with {ImageIdentity="changed"},process)));
        Test("automatic recovery accepts only the journal process",()=>Worker.RequireAutomaticRecoveryIdentity(process,process));
        Test("target arriving after 5s cannot latch positive evidence",()=>
        {
            long elapsed=0;
            var observer=new PollObserver(()=>{elapsed=5_000;return [Row("target")];},"target",()=>false,()=>elapsed,ms=>elapsed+=ms);
            Block(()=>observer.Observe(new Bound(process),TimeSpan.FromSeconds(5)));
            Require(!observer.TargetObserved);
        });
        Test("fresh target remains explicitly incomplete",()=>
        {
            var observer=new PollObserver(()=>[Row("target")],"target",()=>false,()=>1,_=>{});
            var result=observer.Observe(new Bound(process),TimeSpan.FromSeconds(5));
            Require(observer.TargetObserved && !result.CompleteForProcess);
        });
        Test("prepare budget cannot prolong a mutated child",()=>
        {
            var deadline=new WorkerDeadline(105_000,85_000,20_000);
            Require(!deadline.Expired(80_000));deadline.JournalCreated(10_000);
            Require(!deadline.Expired(29_999) && deadline.Expired(30_000));
        });
        Test("duplicate creation marker cannot restart mutation budget",()=>
        {
            var deadline=new WorkerDeadline(105_000,85_000,20_000);
            deadline.JournalCreated(10_000);deadline.JournalCreated(29_999);Require(deadline.Expired(30_000));
        });
        Test("readonly phase and absolute cap are fixed",()=>
        {
            var deadline=new WorkerDeadline(105_000,85_000,20_000);Require(deadline.Expired(85_000));
            deadline.JournalCreated(100_000);Require(deadline.Expired(105_000));
        });
        Test("late first journal marker cannot revive an expired prepare budget",()=>
        {
            var deadline=new WorkerDeadline(105_000,85_000,20_000);
            deadline.JournalCreated(85_000);Require(deadline.Expired(85_000));
        });
        return passed;
    }
    private sealed class Bound(SpotifyProcess identity):IBoundSpotifyPolicy
    {
        public SpotifyProcess Identity=>identity;
        public SpotifyProcess CheckLiveIdentity()=>identity;
        public string? Get(RenderRole role)=>throw new Exception("Observation must not read policy in this fixture");
        public void Set(RenderRole role,string? value)=>throw new Exception("Observation must not mutate");
        public void Dispose() { }
    }
}
