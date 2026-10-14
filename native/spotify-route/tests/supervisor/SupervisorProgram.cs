using System.Diagnostics;
using System.Reflection;
using Folia.RouteRunner;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;
if(args.Contains("--internal-worker") || args.Contains("--internal-recover"))
{
    if(!Supervisor.ValidateWorkerHandshake(args)) return 90;
    var mode=args[Array.IndexOf(args,"--fixture-mode")+1];
    if(mode.StartsWith("prepared-",StringComparison.Ordinal))
    {
        var path=RunJournalProof.ArgumentValue(args,"--journal")!;
        using var self=Process.GetCurrentProcess();
        if(args.Contains("--internal-recover"))
        {
            var import=WorkerChannel.Recovery??throw new Exception("Missing recovery channel");
            // Device-free transport fixture: native duplication is a fake; host
            // parser must bind the recovery child's stamp to the original receipt.
            var terminal=JournalHandoffTests.Terminal(import.Prepared,self.Id,Supervisor.ProcessBirth(self));
            Evidence.Emit("JOURNAL_TERMINAL",mode=="prepared-recovery-bad"?terminal with {PreparedHash=new string('F',64)}:terminal);
            return 5;
        }
        PreparedJournalReceipt? receipt=null;
        using var journal=new FileRouteJournal(path,createNew:true,afterDurableAppend:commit=>
        {
            if(commit.Record.Stage!=RouteStage.Prepared) return;
            receipt=JournalHandoffTests.Prepared(path,self.Id,Supervisor.ProcessBirth(self)) with
                {RunId=WorkerChannel.RunId,Prepared=JournalCommitReceipt.From(commit)};
            if(mode=="prepared-bad") receipt=receipt with {ChildStarted=receipt.ChildStarted+1};
            WorkerChannel.AwaitPreparedAcknowledgement(receipt);
        });
        try {journal.Append(JournalHandoffTests.Record());}
        catch {return 24;}
        Evidence.Emit("FIXTURE_FIRST_SET_AFTER_ACK",new {preparedHash=receipt!.Prepared.FrameHash});
        if(mode is "prepared-crash" or "prepared-recovery-bad") return 23;
        if(mode=="prepared-phase")
        {
            while(!(bool)typeof(Worker).GetProperty("Cancelled",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!) Thread.Sleep(10);
            return 5;
        }
        var terminalRecord=receipt.Prepared.Record with {Revision=2,Stage=RouteStage.RolledBack};journal.Append(terminalRecord);
        var clean=JournalHandoffTests.Terminal(receipt) with {Terminal=JournalCommitReceipt.From(journal.ReadCurrentCommit()!)};
        Evidence.Emit("JOURNAL_TERMINAL",mode=="prepared-terminal-bad"?clean with {PreparedHash=new string('F',64)}:clean);
        return 5;
    }
    if(mode=="phase-readonly") {Thread.Sleep(350);return 0;}
    if(mode is "owned-crash" or "owned-swapped" or "existing-journal-reject" or "early-block" or "cooperative-overflow" or "exit5-only")
    {
        var trace=RunJournalProof.ArgumentValue(args,"--trace")!; var journal=RunJournalProof.ArgumentValue(args,"--journal")!;
        File.AppendAllText(trace,args.Contains("--internal-recover")?"recover\n":"worker\n");
        if(mode=="cooperative-overflow")
        {
            Console.Write(new string('x',132000));Console.Out.Flush();
            while(!(bool)typeof(Worker).GetProperty("Cancelled",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!) Thread.Sleep(10);
            return 5;
        }
        if(mode=="exit5-only") return 5;
        if(mode is "existing-journal-reject" or "early-block") return 2;
        File.WriteAllText(journal,"12345678:0000000000000001");
        Evidence.Emit("JOURNAL_CREATED",new {path=journal,fileIdentity="12345678:0000000000000001"});
        if(mode=="owned-swapped") File.WriteAllText(journal,"12345678:0000000000000002");
        return 23;
    }
    switch(mode)
    {
        case "healthy": Console.WriteLine("{\"status\":\"FIXTURE_HEALTHY\"}"); return 0;
        case "crash": return 23;
        case "hang": Thread.Sleep(Timeout.Infinite); return 99;
        case "cooperate":
            while(!(bool)typeof(Worker).GetProperty("Cancelled",BindingFlags.Static|BindingFlags.NonPublic)!.GetValue(null)!) Thread.Sleep(10);
            Console.WriteLine("{\"status\":\"FIXTURE_CLEANUP\"}"); return 0;
        case "overflow": for(int n=0;n<200;n++) Console.WriteLine(new string('x',65536)); Thread.Sleep(Timeout.Infinite); return 99;
        case "huge-line": Console.Write(new string('x',200000)); Console.Out.Flush(); Thread.Sleep(Timeout.Infinite); return 99;
    }
    return 98;
}
var passed=0;
void Require(bool condition,string text) { if(!condition) throw new Exception(text); }
async Task<Supervisor.Result> Probe(string mode,int limit)
{
    var method=typeof(Supervisor).GetMethod("Child",BindingFlags.Static|BindingFlags.NonPublic)!;
    var old=Console.Out; Console.SetOut(TextWriter.Null);
    try { return await (Task<Supervisor.Result>)method.Invoke(null,new object[]{new[]{"--fixture-mode",mode},false,limit,(Func<bool>)(()=>false)})!; }
    finally { Console.SetOut(old); }
}
async Task Test(string name,string mode,int limit,Action<Supervisor.Result> check)
{ var timer=Stopwatch.StartNew(); var result=await Probe(mode,limit); check(result); Require(timer.ElapsedMilliseconds<limit+6000,"Bound exceeded"); passed++; Console.WriteLine("PASS "+name+" "+System.Text.Json.JsonSerializer.Serialize(result)); }
await Test("normal own child exit observed","healthy",2000,r=>Require(r.Exited&&r.ExitCode==0&&!r.Killed&&!r.TimedOut,"Normal child failure"));
await Test("worker crash exit preserved","crash",2000,r=>Require(r.Exited&&r.ExitCode==23&&!r.Killed,"Crash not observed"));
await Test("native-like blocked child killed and actual exit observed","hang",100,r=>Require(r.Exited&&r.TimedOut&&r.Killed&&r.CancellationSent,"Hang not bounded"));
await Test("cooperative cleanup gets grace before kill","cooperate",100,r=>Require(r.Exited&&r.TimedOut&&!r.Killed&&r.CancellationSent&&r.ExitCode==0,"Cooperative cancellation failed"));
await Test("total child output capped","overflow",2000,r=>Require(r.Exited&&r.OutputLimit&&r.CancellationSent,"Output cap not enforced"));
await Test("individual line capped","huge-line",2000,r=>Require(r.Exited&&r.OutputLimit&&r.CancellationSent,"Line cap not enforced"));
Require(!Supervisor.ValidateWorkerHandshake(["--internal-worker"]),"Unsupervised worker accepted"); passed++; Console.WriteLine("PASS direct worker denied without nonce+parent handshake");
foreach(var (mode,fixture,expectedExit,expectedRecover) in new[]{
    ("preflight","owned-crash",23,false),("roundtrip","owned-crash",93,false),
    ("roundtrip","owned-swapped",93,false),("roundtrip","existing-journal-reject",93,false),
    ("roundtrip","early-block",93,false),("restore","existing-journal-reject",96,false),("restore","cooperative-overflow",96,false),("roundtrip","exit5-only",93,false)})
{
    var dir=Path.Combine(Path.GetTempPath(),"folia-supervisor-ownership-"+Guid.NewGuid());Directory.CreateDirectory(dir);
    var trace=Path.Combine(dir,"trace.txt");var journal=Path.Combine(dir,"journal.jsonl");
    if(fixture=="existing-journal-reject") File.WriteAllText(journal,"OLD_UNRELATED_JOURNAL");
    var method=typeof(Supervisor).GetMethod("RunAsync",BindingFlags.Static|BindingFlags.NonPublic)!;
    var options=new Options(mode,1,"test-target",journal,28000,"device-free-test",true,true,true);
    var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);int code;
    try {code=await (Task<int>)method.Invoke(null,new object[]{new[]{"--fixture-mode",fixture,"--trace",trace,"--journal",journal},options})!;}
    finally {Console.SetOut(old);}
    try
    {
        Require(code==expectedExit,"Unexpected parent exit "+code);
        Require(File.ReadAllLines(trace).SequenceEqual(expectedRecover?new[]{"worker","recover"}:new[]{"worker"}),"Wrong recovery attempt count");
        if(fixture=="existing-journal-reject") Require(File.ReadAllText(journal)=="OLD_UNRELATED_JOURNAL","Old journal modified");
        if(fixture=="cooperative-overflow") Require(output.ToString().Contains("\"ExitCode\":5"),"Fixture did not exercise interrupted child exit5");

        passed++;Console.WriteLine("PASS "+mode+" / "+fixture+" owner-scoped recovery");
    }
    finally {Directory.Delete(dir,true);}
}
{
    var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);int code;
    try{code=Supervisor.ReportUncertainFailure(new IOException("failure after worker may have set policy"),"journal");}
    finally{Console.SetOut(old);}
    Require(code==95 && output.ToString().Contains("\"policyMutationStatus\":\"unknown\"") && !output.ToString().Contains("\"policyCalls\":0"),"Outer failure invented zero mutations");
    passed++;Console.WriteLine("PASS outer failure preserves mutation uncertainty without claiming zero");
}
foreach(var fixture in new[]{"phase-readonly"})
{
    var dir=Path.Combine(Path.GetTempPath(),"folia-a4-phase-"+Guid.NewGuid());Directory.CreateDirectory(dir);
    var journal=Path.Combine(dir,"new-journal.jsonl");
    var method=typeof(Supervisor).GetMethod("ChildCore",BindingFlags.Static|BindingFlags.NonPublic)!;
    var timer=Stopwatch.StartNew();var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);
    Supervisor.Result result;
    try
    {
        result=await (Task<Supervisor.Result>)method.Invoke(null,new object?[]{new[]{"--fixture-mode",fixture,"--journal",journal},false,5_000,(Func<bool>)(()=>false),2_000,150})!;
    }
    finally {Console.SetOut(old);}
    try
    {
        Require(result.Exited && !result.Killed,"Phase fixture did not exit cooperatively");
        if(fixture=="phase-readonly")
            Require(result.ExitCode==0 && !result.TimedOut && result.CreatedJournal==null && timer.ElapsedMilliseconds>=350,"Readonly preparation incorrectly got mutation budget");
        else
            Require(result.ExitCode==5 && result.TimedOut && result.CancellationSent && result.CreatedJournal!=null && timer.ElapsedMilliseconds<2_000,"Mutated child inherited long readonly budget");
        passed++;Console.WriteLine("PASS A4 "+fixture+" separate process phase budget "+System.Text.Json.JsonSerializer.Serialize(result));
    }
    finally {Directory.Delete(dir,true);}
}

foreach(var fixture in new[]{"prepared-clean","prepared-bad","prepared-terminal-bad","prepared-phase","prepared-crash","prepared-recovery-bad"})
{
    var dir=Path.Combine(Path.GetTempPath(),"folia-retained-protocol-"+Guid.NewGuid(),"FoliaRouteTrial");Directory.CreateDirectory(dir);
    var path=Path.Combine(dir,Guid.NewGuid()+".jsonl");
    var transfer=new FakeTransfer();
    var options=new Options("roundtrip",JournalHandoffTests.Spotify.Pid,"target",path,28000,"device-free",true,true,true,true,"original",JournalHandoffTests.Spotify.StartTimeUtcTicks);
    var context=new Supervisor.HandoffContext(JournalHandoffTests.RunId,options,JournalHandoffTests.Storage(path),null,transfer,(_,_,_)=>{});
    var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);Supervisor.Result result;Supervisor.Result? recovery=null;
    try
    {
        result=await Supervisor.ChildBoundCore(["--fixture-mode",fixture,"--journal",path],false,5000,()=>false,2500,150,context,null);
        if(fixture is "prepared-crash" or "prepared-recovery-bad")
        {
            Require(result.Exited && result.ExitCode==23 && result.Retained!=null,"Original crash retention missing");
            recovery=await Supervisor.ChildBoundCore(["--fixture-mode",fixture,"--journal",path],true,2000,()=>false,null,1000,context,result.Retained);
            var failed=false;
            try {await Supervisor.ChildBoundCore(["--fixture-mode",fixture,"--journal",path],true,2000,()=>false,null,1000,context,result.Retained);}
            catch(JournalUnavailableException) {failed=true;}
            Require(failed && transfer.Sent==1,"Recovery attempted more than once");
        }
    }
    finally {Console.SetOut(old);}
    try
    {
        Require(result.Exited,"Fixture child exit not observed");
        if(fixture=="prepared-bad") Require(result.CreatedJournal==null && transfer.Retained==0 && !output.ToString().Contains("FIXTURE_FIRST_SET_AFTER_ACK"),"Invalid Prepared reached simulated setter");
        else Require(result.Retained!=null && transfer.Retained==1 && output.ToString().Contains("FIXTURE_FIRST_SET_AFTER_ACK"),"Prepared ACK did not release fake setter");
        if(fixture=="prepared-clean") Require(Supervisor.CleanTerminal(result),"Clean receipt was not accepted");
        if(fixture=="prepared-terminal-bad") Require(!Supervisor.CleanTerminal(result)&&result.ProtocolFailure,"Bad terminal accepted");
        if(fixture=="prepared-phase") Require(result.TimedOut&&result.CancellationSent&&!Supervisor.CleanTerminal(result),"Prepared phase not bounded");
        if(fixture=="prepared-crash") Require(recovery!=null && Supervisor.CleanTerminal(recovery),"Recovery child terminal not parsed");
        if(fixture=="prepared-recovery-bad") Require(recovery!=null && !Supervisor.CleanTerminal(recovery) && recovery.ProtocolFailure,"Bad recovery terminal accepted");
        passed++;Console.WriteLine("PASS retained Prepared/ACK/terminal fixture "+fixture);
    }
    finally {result.Retained?.Dispose();Directory.Delete(Path.GetDirectoryName(dir)!,true);}
}

foreach(var preflightArgs in new[]{Array.Empty<string>(),new[]{"--preflight","--journal",Path.Combine(Path.GetTempPath(),Guid.NewGuid()+".jsonl")}})
{
    int starts=0;var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);int code;
    try { code=Supervisor.RunWithStorage(preflightArgs,()=>throw new Folia.RouteResearch.RouteBlockedException("knownfolder-api"),(_,_)=>++starts); }
    finally { Console.SetOut(old); }
    Require(code==2 && starts==0 && output.ToString().Contains("\"workerStarted\":false") && output.ToString().Contains("\"policyCalls\":0"),"Pre-start binding failure did not prove zero worker activity");
    passed++;Console.WriteLine("PASS pre-start binding failure with "+(preflightArgs.Length==0?"default preflight":"explicit journal"));
}
{
    var local=Path.Combine(Path.GetTempPath(),"supervisor-binding-user","Local");
    var storage=JournalStorageBinding.FromApiResults(local,Path.Combine(local,"Packages","App_123456789abcd","LocalCache","Local"),null,"sid");
    var filename=Guid.NewGuid()+".jsonl";var logical=Path.Combine(storage.LogicalRoot,filename);var physical=Path.Combine(storage.PhysicalRoot,filename);
    var code=Supervisor.RunWithStorage(new[]{"--preflight","--journal",logical},()=>storage,(arguments,options)=>
    {
        Require(RunJournalProof.ArgumentValue(arguments,"--journal")==physical && options.Journal==physical,"Supervisor did not retain physical path");return 0;
    });
    Require(code==0,"Supervisor canonical binding failed");passed++;Console.WriteLine("PASS supervisor uses canonical physical path for child and proof");
}
Console.WriteLine("SUPERVISOR_TESTS_PASSED="+passed);return 0;

internal sealed class FakeTransfer:IJournalHandleTransfer
{
    internal int Retained,Sent;
    public SafeFileHandle Retain(Process source,long started,string sid,long value)
    {
        if(source.HasExited || Supervisor.ProcessBirth(source)!=started || sid!=JournalHandoffTests.User || value!=99) throw new JournalUnavailableException("FAKE_CHILD_BINDING_INVALID");
        Retained++;return new(new IntPtr(999),false);
    }
    public long Send(Process destination,long started,string sid,SafeFileHandle retained)
    {
        if(destination.HasExited || Supervisor.ProcessBirth(destination)!=started || retained.IsClosed) throw new JournalUnavailableException("FAKE_RECOVERY_BINDING_INVALID");
        Sent++;return 998;
    }
}
