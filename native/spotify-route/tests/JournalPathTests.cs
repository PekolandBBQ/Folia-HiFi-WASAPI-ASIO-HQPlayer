using System.Text.Json;
using Folia.RouteResearch;
using Folia.RouteRunner;

internal static class JournalPathTests
{
    private sealed class Probe:IDisposable { internal bool Disposed; public void Dispose()=>Disposed=true; }
    internal static int Run()
    {
        int passed=0;
        void Test(string name,Action action) { action();passed++;Console.WriteLine("PASS journal-path: "+name); }
        void Require(bool value) { if(!value) throw new Exception("Journal path assertion failed"); }
        void Reject(Action action) { try { action(); } catch(Exception e) when(e is RouteBlockedException or JournalUnavailableException) { return; } throw new Exception("Expected journal path rejection"); }
        var temp=Path.Combine(Path.GetTempPath(),"folia-path-tests-"+Guid.NewGuid().ToString("N"));
        var local=Path.Combine(temp,"current-user","Local");
        const string family="OpenAI.Codex_2p2nqsd0c76g0",otherFamily="Unrelated.App_123456789abcd",sid="S-1-5-21-1001";
        var target=Path.Combine(local,"Packages",family,"LocalCache","Local");
        var unpackaged=JournalStorageBinding.FromApiResults(local,local,null,sid);
        var packaged=JournalStorageBinding.FromApiResults(local,target,family,sid);
        var filename=Guid.NewGuid().ToString("D")+".jsonl";
        var logicalFile=Path.Combine(unpackaged.LogicalRoot,filename);
        var physicalFile=Path.Combine(packaged.PhysicalRoot,filename);
        Test("normal unpackaged path unchanged",()=>Require(unpackaged.Bind(logicalFile)==logicalFile));
        Test("documented own-package redirect binds exact physical path",()=>Require(packaged.Bind(logicalFile)==physicalFile));
        Test("same-process canonical physical path is accepted",()=>Require(packaged.Bind(physicalFile)==physicalFile));
        Test("package identity does not require virtualization",()=>Require(JournalStorageBinding.FromApiResults(local,local,family,sid).PhysicalRoot==unpackaged.PhysicalRoot));
        Test("unrelated package known-folder target rejected",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(local,"Packages",otherFamily,"LocalCache","Local"),family,sid)));
        Test("other-user target rejected",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(temp,"other-user","Local","Packages",family,"LocalCache","Local"),family,sid)));
        Test("explicit NoPackage with official target remains eligible for mandatory handle proof",()=>
        {
            var binding=JournalStorageBinding.FromApiResults(local,target,null,sid);
            Require(binding.PackageFamily==null && binding.PackageIdentityState=="NoPackage" && binding.RedirectedPackageComponent==family && binding.Bind(logicalFile)==physicalFile);
        });
        Test("NoPackage cannot accept another-user target",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(temp,"other-user","Packages",family,"LocalCache","Local"),null,sid)));
        Test("NoPackage cannot accept extra package path components",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(local,"Packages",family,"extra","LocalCache","Local"),null,sid)));
        Test("NoPackage cannot accept arbitrary existing root",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(temp,"other-cache"),null,sid)));
        Test("only exact no-package status is accepted",()=>Require(JournalStorage.IsNoPackageProbe(15700,0)));
        foreach(var error in new[]{0,5,87,1113,15701})
            Test("package probe failure blocks: "+error,()=>Reject(()=>JournalStorage.IsNoPackageProbe(error,0)));
        Test("valid package sizing requires second native call",()=>Require(!JournalStorage.IsNoPackageProbe(122,30)));
        Test("invalid package size blocks",()=>Reject(()=>JournalStorage.IsNoPackageProbe(122,0)));
        Test("logical KnownFolder API failure blocks resolution",()=>Reject(()=>JournalStorage.ResolveFrom(_=>throw new RouteBlockedException("api-failure"),()=>null,()=>sid)));
        Test("physical KnownFolder API failure blocks resolution",()=>Reject(()=>JournalStorage.ResolveFrom(flag=>flag==JournalStorage.NoPackageRedirection?local:throw new RouteBlockedException("api-failure"),()=>null,()=>sid)));
        Test("package API failure never becomes no-package",()=>Reject(()=>JournalStorage.ResolveFrom(_=>local,()=>throw new RouteBlockedException("package-api-failure"),()=>sid)));
        Test("mid-resolution identity state change blocks",()=> { var reads=0;Reject(()=>JournalStorage.ResolveFrom(_=>local,()=>++reads==1?null:family,()=>sid)); });
        Test("mid-resolution user change blocks",()=> { var reads=0;Reject(()=>JournalStorage.ResolveFrom(_=>local,()=>null,()=>++reads==1?sid:"other")); });
        Test("NoPackage official resolver keeps explicit state",()=>Require(JournalStorage.ResolveFrom(flag=>flag==JournalStorage.NoPackageRedirection?local:target,()=>null,()=>sid).PackageIdentityState=="NoPackage"));
        Test("empty package identity is not unpackaged",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,target,"",sid)));
        Test("missing user identity rejected",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,target,family,"")));
        Test("package traversal rejected",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,target,"../other",sid)));
        Test("arbitrary local target rejected",()=>Reject(()=>JournalStorageBinding.FromApiResults(local,Path.Combine(temp,"cache"),family,sid)));
        Test("root prefix lookalike rejected",()=>Reject(()=>packaged.Bind(Path.Combine(packaged.LogicalRoot+"-other",filename))));
        Test("subdirectory rejected",()=>Reject(()=>packaged.Bind(Path.Combine(packaged.LogicalRoot,"child",filename))));
        Test("non-guid filename rejected",()=>Reject(()=>packaged.Bind(Path.Combine(packaged.LogicalRoot,"latest.jsonl"))));
        Test("relative file rejected",()=>Reject(()=>packaged.Bind(filename)));
        Test("other package canonical file rejected",()=>Reject(()=>packaged.Bind(Path.Combine(local,"Packages",otherFamily,"LocalCache","Local","FoliaRouteTrial",filename))));
        Test("unpackaged restart cannot reinterpret old physical path",()=>Reject(()=>unpackaged.Bind(physicalFile)));
        Test("same-package restart resolves same exact file",()=>Require(JournalStorageBinding.FromApiResults(local,target,family,sid).Bind(physicalFile)==physicalFile));
        Test("same-process binding agrees",()=>JournalStorageBinding.RequireSameContext(packaged,packaged with {}));
        Test("changed user context rejected",()=>Reject(()=>JournalStorageBinding.RequireSameContext(packaged,packaged with {UserSid="S-1-5-21-1002"})));
        Test("changed package even without redirection rejected",()=>Reject(()=>JournalStorageBinding.RequireSameContext(unpackaged,unpackaged with {PackageFamily=family})));
        Test("changed API-selected package component rejected",()=>Reject(()=>JournalStorageBinding.RequireSameContext(packaged,packaged with {RedirectedPackageComponent=otherFamily})));
        Test("NoPackage to successful package identity changes run context",()=>Reject(()=>JournalStorageBinding.RequireSameContext(packaged,packaged with {PackageFamily=null})));
        Test("changed physical context rejected",()=>Reject(()=>JournalStorageBinding.RequireSameContext(packaged,unpackaged)));
        Test("missing parent binding rejected",()=>Reject(()=>JournalStorageBinding.RequireSameContext(packaged,null)));
        var directory=new JournalGuard.DirectoryIdentity(0x10,1,0,12,packaged.PhysicalRoot);
        Test("exact physical directory identity accepted",()=>JournalGuard.CheckDirectory(directory,packaged.PhysicalRoot));
        Test("arbitrary handle mismatch rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {FinalPath=unpackaged.PhysicalRoot},packaged.PhysicalRoot)));
        Test("reparse directory rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {Attributes=0x410},packaged.PhysicalRoot)));
        Test("non-directory rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {Attributes=0},packaged.PhysicalRoot)));
        Test("zero file identity rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {Low=0},packaged.PhysicalRoot)));
        Test("changed pinned handle identity rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {Low=13},packaged.PhysicalRoot,directory)));
        Test("changed pinned volume rejected",()=>Reject(()=>JournalGuard.CheckDirectory(directory with {Volume=2},packaged.PhysicalRoot,directory)));
        Test("same retained handle accepted",()=>JournalGuard.CheckDirectory(directory,packaged.PhysicalRoot,directory));
        Test("logical alias must be the same physical file ID",()=>Reject(()=>JournalGuard.RequireSameDirectory(directory,directory with {Low=13})));
        Test("logical alias must be on the same volume",()=>Reject(()=>JournalGuard.RequireSameDirectory(directory,directory with {Volume=2})));
        Test("logical and physical directory IDs agree",()=>JournalGuard.RequireSameDirectory(directory,directory with {}));
        Test("missing readonly root stays missing",()=> { Reject(()=>JournalPath.Check(unpackaged,logicalFile,true,false));Require(!Directory.Exists(temp)); });
        Directory.CreateDirectory(packaged.PhysicalRoot);
        try
        {
            Test("readonly path proof creates no journal",()=> { JournalPath.Check(packaged,physicalFile,true,false);Require(!File.Exists(physicalFile)); });
            File.WriteAllText(physicalFile,"retained journal");
            Test("existing journal cannot authorize create",()=>Reject(()=>JournalPath.Check(packaged,physicalFile,true,false)));
            Test("explicit existing physical restore path remains valid",()=>JournalPath.Check(packaged,physicalFile,false,false));
            File.Delete(physicalFile);
            Test("missing restore journal rejected",()=>Reject(()=>JournalPath.Check(packaged,physicalFile,false,false)));
            if(!OperatingSystem.IsWindows())
            {
                var linked=Path.Combine(packaged.PhysicalRoot,"linked");Directory.CreateSymbolicLink(linked,temp);
                Test("real reparse ancestry rejected before file access",()=>Reject(()=>JournalPath.Check(packaged with {LogicalRoot=linked,PhysicalRoot=linked},Path.Combine(linked,filename),true,false)));
                Directory.Delete(linked);
            }
        }
        finally { Directory.Delete(temp,true); }
        const string id="12345678:0000000000000001";
        string Marker(JournalStorageBinding? storage,string file= id,string? path=null)=>JsonSerializer.Serialize(new {status="JOURNAL_CREATED",evidence=new {path=path??physicalFile,fileIdentity=file,storage}});
        Test("legacy created marker grants no retained prepared authority",()=> { var proof=new RunJournalProof(physicalFile,packaged);proof.ObserveLine(Marker(packaged));Require(proof.Get()==null); });
        Test("logical marker cannot replace expected physical file",()=> { var proof=new RunJournalProof(physicalFile,packaged);proof.ObserveLine(Marker(packaged,path:logicalFile));Require(proof.Get()==null); });
        Test("marker from other user rejected",()=> { var proof=new RunJournalProof(physicalFile,packaged);proof.ObserveLine(Marker(packaged with {UserSid="other"}));Require(proof.Get()==null); });
        Test("marker missing storage binding rejected",()=> { var proof=new RunJournalProof(physicalFile,packaged);proof.ObserveLine(Marker(null));Require(proof.Get()==null); });
        Test("old journal alone still grants no recovery",()=>Require(new RunJournalProof(physicalFile,packaged).Get()==null));
        Test("replacement journal ID still rejected in recovery",()=>Reject(()=>JournalGuard.RequireExpectedIdentity("12345678:0000000000000002",id)));
        Test("resolver failure reports hardzero before acquire or policy",()=>
        {
            var calls=0;var old=Console.Out;using var output=new StringWriter();Console.SetOut(output);int result;
            try { result=JournalPathGate.Run<Probe>(()=>throw new RouteBlockedException("knownfolder-api"),null,false,(_,_)=> {calls++;return new Probe();},(_,_,_)=>++calls); }
            finally { Console.SetOut(old); }
            Require(result==2 && calls==0 && output.ToString().Contains("\"policyCalls\":0") && output.ToString().Contains("JOURNAL_PATH_PREFLIGHT_BLOCKED"));
        });
        Test("failed directory proof permits no policy continuation",()=>
        {
            var calls=0;var result=JournalPathGate.Run<Probe>(packaged,logicalFile,false,(_,_)=>throw new JournalUnavailableException("denied"),(_,_)=>++calls);
            Require(result==2 && calls==0);
        });
        Test("NoPackage mapping still requires physical handle proof",()=>
        {
            var calls=0;var noPackage=JournalStorageBinding.FromApiResults(local,target,null,sid);
            var result=JournalPathGate.Run<Probe>(noPackage,logicalFile,false,(_,_)=>throw new JournalUnavailableException("logical-physical-mismatch"),(_,_)=>++calls);
            Require(result==2 && calls==0);
        });
        Test("invalid path never acquires proof or reaches policy",()=>
        {
            var calls=0;var result=JournalPathGate.Run(packaged,Path.Combine(temp,filename),false,(_,_)=> {calls++;return new Probe();},(_,_)=>++calls);
            Require(result==2 && calls==0);
        });
        Test("proof remains held across policy continuation and is then disposed",()=>
        {
            var pin=new Probe();var result=JournalPathGate.Run(packaged,logicalFile,false,(path,create)=> {Require(path==physicalFile && !create);return pin;},(path,held)=> {Require(path==physicalFile && !held.Disposed);return 5;});
            Require(result==5 && pin.Disposed);
        });
        Test("continuation failure releases proof without rewriting policy history",()=>
        {
            var pin=new Probe();bool thrown=false;
            try { JournalPathGate.Run(packaged,logicalFile,true,(_,create)=> {Require(create);return pin;},(_,_)=>throw new InvalidOperationException("after-policy")); }
            catch(InvalidOperationException){thrown=true;}
            Require(thrown && pin.Disposed);
        });
        return passed;
    }
}
