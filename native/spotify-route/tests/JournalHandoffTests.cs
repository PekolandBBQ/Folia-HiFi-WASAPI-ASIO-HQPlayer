using System.Text.Json;
using Folia.RouteResearch;
using Folia.RouteRunner;
using Microsoft.Win32.SafeHandles;

internal static class JournalHandoffTests
{
    internal const string User="S-1-5-21-1001",FileId="12345678:0000000000000025";
    internal static readonly string RunId=new('A',64);
    internal static readonly SpotifyProcess Spotify=new(444,123456789,User,"spotify-policy","verified-image","desktop");
    internal static JournalStorageBinding Storage(string path)
    {
        var root=Path.GetDirectoryName(path)!;
        return new(root,root,null,User,null,"12345678:0000000000000001","12345678:0000000000000002",
            JournalSecurity.Policy,1,new string('C',64),root);
    }
    internal static RouteRecord Record()=>new(1,1,Guid.NewGuid(),Spotify,Spotify,
        new("target","raw-target","owner","driver",true,true,true),RouteStage.Prepared,
        [new(RenderRole.Console,null,RoleStage.Untouched),new(RenderRole.Multimedia,"raw-multimedia",RoleStage.Untouched),new(RenderRole.Communications,"raw-communications",RoleStage.Untouched)],null,DateTimeOffset.UtcNow);
    internal static PreparedJournalReceipt Prepared(string path,int child=22,long birth=33)=>new(RunId,child,birth,User,path,FileId,Storage(path),99,new(Record(),512,new string('B',64)),true);
    internal static TerminalJournalReceipt Terminal(PreparedJournalReceipt p,int? child=null,long? birth=null)=>new(p.RunId,child??p.ChildPid,birth??p.ChildStarted,p.UserSid,p.Path,p.FileIdentity,p.Storage,p.Prepared.FrameHash,p.Prepared.CommittedLength,
        new(p.Prepared.Record with {Revision=2,Stage=RouteStage.RolledBack},p.Prepared.CommittedLength+512,new string('D',64)),
        p.Prepared.Record.Roles.Select(r=>new RoleReadback(r.Role,r.Original,r.Original)).ToArray());
    internal static RunJournalProof Proof(PreparedJournalReceipt p)=>new(p.Path,p.Storage,p.RunId,Spotify.Pid,Spotify.StartTimeUtcTicks,"target");
    private static SafeFileHandle FakeHandle()=>new(new IntPtr(999),false);
    internal static int Run()
    {
        int passed=0;
        void Test(string name,Action body) {body();passed++;Console.WriteLine("PASS journal-handoff: "+name);}
        void Require(bool value) {if(!value)throw new Exception("Handoff assertion failed");}
        void Reject(Action body) {try{body();}catch(Exception e)when(e is JournalUnavailableException or RouteBlockedException or InvalidDataException){return;}throw new Exception("Unsafe handoff accepted");}
        var path=Path.Combine(Path.GetTempPath(),"FoliaRouteTrial",Guid.NewGuid()+".jsonl");
        Test("Prepared authority requires retained handle and clones raw null originals",()=>
        {
            var p=Prepared(path);var proof=Proof(p);using var held=proof.AcceptPrepared(p,22,33,User,_=>FakeHandle());
            p.Prepared.Record.Roles[0]=p.Prepared.Record.Roles[0] with {Original="tampered"};
            Require(proof.Get()?.FileIdentity==FileId && held.Receipt.Prepared.Record.Roles[0].Original==null);
            var exposed=held.Receipt;exposed.Prepared.Record.Roles[0]=exposed.Prepared.Record.Roles[0] with {Original="tampered-again"};
            Require(held.Receipt.Prepared.Record.Roles[0].Original==null);
        });
        foreach(var edit in new Func<PreparedJournalReceipt,PreparedJournalReceipt>[] {
            p=>p with {RunId=new string('F',64)},p=>p with {ChildPid=23},p=>p with {ChildStarted=34},p=>p with {UserSid="other"},
            p=>p with {HandleValue=0},p=>p with {Fresh=false},p=>p with {Path=path+"-other"},p=>p with {FileIdentity="bad"},
            p=>p with {Storage=p.Storage with {RootIdentity="12345678:0000000000000022"}},p=>p with {Storage=p.Storage with {IdentityVersion=0}},
            p=>p with {Prepared=p.Prepared with {CommittedLength=0}},p=>p with {Prepared=p.Prepared with {FrameHash="bad"}},
            p=>p with {Prepared=p.Prepared with {Record=p.Prepared.Record with {Revision=2}}},
            p=>p with {Prepared=p.Prepared with {Record=p.Prepared.Record with {Stage=RouteStage.Applying}}},
            p=>p with {Prepared=p.Prepared with {Record=p.Prepared.Record with {CurrentProcess=Spotify with {StartTimeUtcTicks=123456790}}}},
            p=>p with {Prepared=p.Prepared with {Record=p.Prepared.Record with {Target=p.Prepared.Record.Target with {Id="wrong-target"}}}}})
            Test("mismatched Prepared binding rejected before duplicate",()=>
            {var p=Prepared(path);var proof=Proof(p);int copies=0;Reject(()=>proof.AcceptPrepared(edit(p),22,33,User,_=>{copies++;return FakeHandle();}));Require(copies==0 && proof.Get()==null);});
        Test("failed duplicate cannot grant authority",()=>
        {var p=Prepared(path);var proof=Proof(p);Reject(()=>proof.AcceptPrepared(p,22,33,User,_=>throw new JournalUnavailableException("denied")));Require(proof.Get()==null);});
        Test("duplicate Prepared invalidates authority without replacing retained object",()=>
        {var p=Prepared(path);var proof=Proof(p);using var held=proof.AcceptPrepared(p,22,33,User,_=>FakeHandle());Reject(()=>proof.AcceptPrepared(p,22,33,User,_=>FakeHandle()));Require(proof.Get()==null && proof.OwnedRetention==held);});
        Test("retained object cannot be recovered before actual original exit",()=>
        {using var held=new RetainedJournal(Prepared(path),FakeHandle());Reject(held.ClaimRecovery);});
        Test("terminal must have a durable terminal commit and all three exact raw originals",()=>
        {var p=Prepared(path);var proof=Proof(p);using var held=proof.AcceptPrepared(p,22,33,User,_=>FakeHandle());proof.AcceptTerminal(Terminal(p),22,33,User);Require(proof.TerminalValidated);});
        Test("exit5 alone and interrupted terminal never count as clean restoration",()=>
        {
            Require(!Supervisor.CleanTerminal(new(5,true,false,false,false,false,null)));
            foreach(var r in new[]{new Supervisor.Result(5,true,true,false,false,false,null,true),new(5,true,false,true,false,false,null,true),new(5,true,false,false,true,false,null,true),new(5,true,false,false,false,true,null,true),new(5,true,false,false,false,false,null,true,ProtocolFailure:true),new(0,true,false,false,false,false,null,true)}) Require(!Supervisor.CleanTerminal(r));
            Require(Supervisor.CleanTerminal(new(5,true,false,false,false,false,null,true)));
        });
        foreach(var edit in new Func<TerminalJournalReceipt,TerminalJournalReceipt>[] {
            t=>t with {RunId=new string('F',64)},t=>t with {ChildPid=99},t=>t with {ChildStarted=99},t=>t with {UserSid="other"},
            t=>t with {FileIdentity="12345678:0000000000000026"},t=>t with {PreparedHash=new string('F',64)},t=>t with {PreparedLength=513},
            t=>t with {Storage=t.Storage with {RootIdentity="12345678:0000000000000026"}},
            t=>t with {Terminal=t.Terminal with {Record=t.Terminal.Record with {Stage=RouteStage.Prepared}}},
            t=>t with {Terminal=t.Terminal with {Record=t.Terminal.Record with {TransactionId=Guid.NewGuid()}}},
            t=>t with {Terminal=t.Terminal with {Record=t.Terminal.Record with {Target=t.Terminal.Record.Target with {Id="other"}}}},
            t=>t with {Terminal=t.Terminal with {FrameHash="bad"}},t=>t with {Values=t.Values.Take(2).ToArray()},
            t=>t with {Values=t.Values.Select(x=>x.Role==RenderRole.Console?x with {Actual="not-null"}:x).ToArray()},
            t=>t with {Values=t.Values.Select(x=>x.Role==RenderRole.Communications?x with {Expected="wrong",Actual="wrong"}:x).ToArray()}})
            Test("mismatched terminal cannot claim restoration",()=>
            {var p=Prepared(path);var proof=Proof(p);using var held=proof.AcceptPrepared(p,22,33,User,_=>FakeHandle());Reject(()=>proof.AcceptTerminal(edit(Terminal(p)),22,33,User));Require(!proof.TerminalValidated);});
        Test("terminal without Prepared is rejected",()=>{var p=Prepared(path);Reject(()=>Proof(p).AcceptTerminal(Terminal(p),22,33,User));});
        Test("single dispatcher reader rejects oversized and truncated commands",()=>
        {Reject(()=>WorkerChannel.ReadBoundedLineAsync(new StringReader(new string('x',20)+"\n"),10).GetAwaiter().GetResult());Reject(()=>WorkerChannel.ReadBoundedLineAsync(new StringReader("partial"),10).GetAwaiter().GetResult());Require(WorkerChannel.ReadBoundedLineAsync(new StringReader("CANCEL\n"),10).GetAwaiter().GetResult()=="CANCEL");});
        Test("whole imported journal provenance rejects changed intermediate frame before torn-tail write",()=>
        {
            var journalPath=Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".jsonl");PreparedJournalReceipt p;
            try
            {
                using(var journal=new FileRouteJournal(journalPath,createNew:true))
                {
                    var first=Record();journal.Append(first);p=Prepared(path) with {Prepared=JournalCommitReceipt.From(journal.ReadFirstCommit()!)};
                    journal.Append(first with {Revision=2,TransactionId=Guid.NewGuid()});
                    journal.Append(first with {Revision=3,Stage=RouteStage.RolledBack});
                }
                File.AppendAllText(journalPath,"TORN");var bytes=File.ReadAllBytes(journalPath);
                var handle=File.OpenHandle(journalPath,FileMode.Open,FileAccess.ReadWrite,FileShare.None);
                Reject(()=>{using var imported=new FileRouteJournal(handle,_=>{},validateReadCommit:c=>RunJournalProof.ValidateReadCommit(p,c));});
                Require(handle.IsClosed && bytes.SequenceEqual(File.ReadAllBytes(journalPath)));
            }
            finally {File.Delete(journalPath);}
        });
        foreach(var lossPoint in new[]{"after-first-set","restore-intent"})
            Test("parent loss at "+lossPoint+" blocks new apply and preserves durable owned compensation",()=>
            {
                var journalPath=Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".jsonl");
                try
                {
                    var alive=true;FileRouteJournal? current=null;var resolver=new CompensationResolver();
                    using var journal=new FileRouteJournal(journalPath,createNew:true,afterDurableAppend:commit=>
                    {
                        if(lossPoint=="restore-intent" && commit.Record.Roles.Any(r=>r.Stage==RoleStage.RestoreIntent)) alive=false;
                        // Matches the host callback: only the initial Prepared
                        // retention barrier depends on parent communication.
                        if(commit.Record.Stage==RouteStage.Prepared && !alive) throw new JournalUnavailableException("missing ACK");
                    });
                    current=journal;
                    resolver.BeforeSet=()=>Worker.RequireParentForApply(current.ReadLatest(),()=>
                    {if(!alive) throw new JournalUnavailableException("parent gone");});
                    resolver.AfterSet=()=>{if(lossPoint=="after-first-set" && resolver.Sets.Count==1) alive=false;};
                    var tx=new OwnedRouteTransaction(resolver,new SameEndpoint(),new IncompleteObserver(),journal);
                    var result=tx.Begin(Spotify,Record().Target);
                    Require(!alive && result.Stage==RouteStage.RolledBack && resolver.Values.SequenceEqual(Record().Roles.Select(x=>x.Original)));
                    Require(resolver.Sets.Count==(lossPoint=="after-first-set"?2:4));
                    if(lossPoint=="after-first-set") Require(resolver.Sets.All(x=>x==RenderRole.Console));
                    Require(journal.ReadCurrentCommit()!.Record.Stage==RouteStage.RolledBack);
                }
                finally {File.Delete(journalPath);}
            });
        Test("sealing pending native retention is bounded and closes a late duplicate",()=>
        {
            var p=Prepared(path);var proof=Proof(p);using var started=new ManualResetEventSlim();using var release=new ManualResetEventSlim();
            SafeFileHandle? late=null;
            var task=Task.Run(()=>
            {
                try {proof.AcceptPrepared(p,22,33,User,_=>{started.Set();release.Wait();return late=FakeHandle();});return false;}
                catch(JournalUnavailableException) {return true;}
            });
            Require(started.Wait(2000));var timer=System.Diagnostics.Stopwatch.StartNew();proof.CloseObservations(true);
            Require(timer.ElapsedMilliseconds<500 && proof.Get()==null);release.Set();Require(task.GetAwaiter().GetResult() && late!.IsClosed && proof.Get()==null);
        });
        Test("broken diagnostic stdout withdraws apply and cannot break owned compensation",()=>
        {
            var journalPath=Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".jsonl");var originalOut=Console.Out;
            try
            {
                using var journal=new FileRouteJournal(journalPath,createNew:true);var resolver=new CompensationResolver();
                resolver.BeforeSet=()=>Worker.RequireParentForApply(journal.ReadLatest(),()=>
                {if(!Evidence.OutputAvailable) throw new JournalUnavailableException("output lost");});
                resolver.AfterSet=()=>Evidence.Emit("FAKE_POLICY_CALL",new {role=resolver.Sets[^1]});
                Console.SetOut(new BrokenWriter());
                var tx=new OwnedRouteTransaction(resolver,new SameEndpoint(),new IncompleteObserver(),journal);
                var result=tx.Begin(Spotify,Record().Target);
                Require(result.Stage==RouteStage.RolledBack && resolver.Sets.Count==2 && !Evidence.OutputAvailable &&
                    resolver.Values.SequenceEqual(Record().Roles.Select(x=>x.Original)));
            }
            finally {Console.SetOut(originalOut);File.Delete(journalPath);}
        });
        return passed;
    }
    private sealed class CompensationResolver:IVerifiedSpotifyResolver
    {
        internal readonly string?[] Values=Record().Roles.Select(r=>r.Original).ToArray();
        internal readonly List<RenderRole> Sets=[];
        internal Action BeforeSet=()=>{},AfterSet=()=>{};
        public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected)=>new Bound(this);
        private sealed class Bound(CompensationResolver owner):IBoundSpotifyPolicy
        {
            public SpotifyProcess Identity=>Spotify;
            public SpotifyProcess CheckLiveIdentity()=>Spotify;
            public string? Get(RenderRole role)=>owner.Values[(int)role];
            public void Set(RenderRole role,string? value)
            {owner.BeforeSet();owner.Values[(int)role]=value;owner.Sets.Add(role);owner.AfterSet();}
            public void Dispose() {}
        }
    }
    private sealed class SameEndpoint:ISelectedEndpointVerifier
    {public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected)=>expected;}
    private sealed class IncompleteObserver:ISessionObserver
    {public SessionObservation Observe(IBoundSpotifyPolicy process,TimeSpan budget)=>new(false,Spotify,DateTimeOffset.UtcNow,[]);}

    private sealed class BrokenWriter:TextWriter
    {
        public override System.Text.Encoding Encoding=>System.Text.Encoding.UTF8;
        public override void WriteLine(string? text)=>throw new IOException("simulated broken stdout");
        public override void Flush()=>throw new IOException("simulated broken stdout");
    }

}
