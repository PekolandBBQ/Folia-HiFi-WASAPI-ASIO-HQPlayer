using Folia.RouteResearch;
using Folia.RouteRunner;
using Microsoft.Win32.SafeHandles;

internal static class ProductJournalInitializationTests
{
    internal static int Run()
    {
        var count=0;
        void Check(bool value){if(!value)throw new Exception("Product journal initialization assertion failed");}
        void Test(string name,Action action){action();count++;Console.WriteLine("PASS product root "+name);}
        void Reject(Probe probe)
        {
            try{using var root=probe.Acquire();throw new Exception("Unsafe initialization accepted");}
            catch(Exception error)when(error is JournalUnavailableException or RouteBlockedException){ }
            Check(probe.LivePins==0);
        }
        Test("first root created only after all parents pinned and validated",()=>
        {
            var probe=new Probe();using(var root=probe.Acquire())
            {Check(probe.CreateCalls==1&&probe.Created==1&&probe.AllParentsHeldAtCreate&&probe.LivePins>0);root.Binding.RequireObjectProof();}
            Check(probe.LivePins==0&&probe.CreatorDisposed);
        });
        Test("existing root and historical journals are preserved without writer open",()=>
        {
            var probe=new Probe();probe.AddRoot();using var root=probe.Acquire();
            Check(probe.CreatorOpens==0&&probe.CreateCalls==0&&probe.History.SequenceEqual(["history.jsonl"]));
        });
        Test("concurrent directory creation is validated without replacement",()=>
        {
            var probe=new Probe();probe.OnCreate=()=>probe.AddRoot();using var root=probe.Acquire();
            Check(probe.CreateCalls==1&&probe.Created==0&&probe.History.Count==1);
        });
        Test("existing reparse root is rejected without create or repair",()=>
        {
            var probe=new Probe();probe.AddRoot(reparse:true);Reject(probe);Check(probe.CreateCalls==0);
        });
        Test("parent reparse attack before writer handoff performs no creation",()=>
        {
            var probe=new Probe();probe.OnCreatorOpen=()=>probe.ReparseParent();Reject(probe);Check(probe.CreateCalls==0);
        });
        Test("concurrent leaf reparse is never followed or replaced",()=>
        {
            var probe=new Probe();probe.OnCreate=()=>probe.AddRoot(reparse:true);Reject(probe);Check(probe.Created==0&&probe.CreateCalls==1);
        });
        Test("creation remains bound to original parent during a later path attack",()=>
        {
            var probe=new Probe();var expected=probe.ParentIdentity;probe.OnCreate=()=>probe.ReparseParent();Reject(probe);
            Check(probe.CreatedUnderParent==expected&&probe.Created==1);
        });
        Test("unsafe inherited child DACL is rejected without ACL repair",()=>
        {
            var probe=new Probe{UnsafeInheritance=true};Reject(probe);Check(probe.Created==1&&probe.CreateCalls==1);
        });
        Test("unsafe existing root security is not recreated",()=>
        {
            var probe=new Probe();probe.AddRoot(unsafeSecurity:true);Reject(probe);Check(probe.CreateCalls==0&&probe.CreatorOpens==0);
        });
        Test("missing parent cannot trigger recursive directory creation",()=>
        {
            var probe=new Probe();probe.RemoveParent();Reject(probe);Check(probe.CreateCalls==0);
        });
        Test("known-folder identity drift stops before creation",()=>
        {
            var probe=new Probe{ChangeContext=true};Reject(probe);Check(probe.CreateCalls==0);
        });
        Test("UNC and alternate leaf names are rejected before any directory open",()=>
        {
            foreach(var root in new[]{@"\\server\share\FoliaRouteTrial",Path.Combine(Path.GetTempPath(),"not-owned-name")})
            {
                var probe=new Probe();probe.Api=probe.Api with{LogicalRoot=root,PhysicalRoot=root};Reject(probe);Check(probe.DirectoryOpens==0&&probe.CreateCalls==0);
            }
        });
        return count;
    }
    private sealed class Probe:IJournalRootProbe
    {
        private const string Sid="S-1-5-21-4242";
        private readonly Dictionary<string,JournalObjectInfo> objects=new(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string,int> held=new(StringComparer.OrdinalIgnoreCase);
        private uint nextId=1;private int resolves;
        internal JournalStorageBinding Api;
        internal int LivePins,DirectoryOpens,CreateCalls,Created,CreatorOpens;
        internal bool UnsafeInheritance,ChangeContext,AllParentsHeldAtCreate,CreatorDisposed;
        internal string? CreatedUnderParent;
        internal Action? OnCreatorOpen,OnCreate;
        internal List<string> History=["history.jsonl"];
        private string Parent=>Path.GetDirectoryName(Api.PhysicalRoot)!;
        internal string ParentIdentity=>objects[Parent].ObjectIdentity;
        internal Probe()
        {
            var local=Path.Combine(Path.GetTempPath(),"folia-root-mock","user","Local");
            Api=JournalStorageBinding.FromApiResults(local,local,null,Sid);
            for(var directory=new DirectoryInfo(local);directory is not null;directory=directory.Parent) objects.Add(directory.FullName,Info(directory.FullName));
        }
        private JournalObjectInfo Info(string path,bool reparse=false,bool unsafeSecurity=false)=>new(
            new(0x10u|(reparse?0x400u:0u),0x12345678,0,nextId++,path),1,1,"NTFS",8,3,false,
            new(Sid,true,[new(0,0,0x001F01FF,unsafeSecurity?"S-1-1-0":Sid)]));
        internal void AddRoot(bool reparse=false,bool unsafeSecurity=false)=>objects.TryAdd(Api.PhysicalRoot,Info(Api.PhysicalRoot,reparse,unsafeSecurity));
        internal void ReparseParent(){var value=objects[Parent];objects[Parent]=value with{Identity=value.Identity with{Attributes=0x410}};}
        internal void RemoveParent()=>objects.Remove(Parent);
        public JournalStorageBinding Resolve(){resolves++;return ChangeContext&&resolves>1?Api with{UserSid="S-other"}:Api;}
        public IJournalDirectoryPin OpenDirectory(string path)
        {
            DirectoryOpens++;
            if(!objects.ContainsKey(path))throw new JournalUnavailableException("JOURNAL_DIRECTORY_MISSING_READONLY_PREFLIGHT");
            LivePins++;held[path]=held.GetValueOrDefault(path)+1;return new Pin(this,path);
        }
        public JournalObjectInfo ReadLeaf(SafeFileHandle handle)=>throw new Exception("No leaf journal may open during initialization");
        internal JournalRootLease Acquire()=>ProductJournalRootInitializer.Acquire(this,(path,expected)=>
        {CreatorOpens++;OnCreatorOpen?.Invoke();return new Creation(this,path,expected);});
        private sealed class Pin(Probe owner,string path):IJournalDirectoryPin
        {
            private bool disposed;
            public JournalObjectInfo Read()=>owner.objects[path];
            public void Dispose(){if(disposed)return;disposed=true;owner.LivePins--;owner.held[path]--;}
        }
        private sealed class Creation(Probe owner,string path,JournalObjectInfo original):IProductRootCreation
        {
            public void Validate()
            {
                var current=owner.objects[path];JournalGuard.CheckDirectory(current.Identity,path,original.Identity);
                if(current.Security.Digest!=original.Security.Digest)throw new JournalUnavailableException("JOURNAL_SECURITY_CHANGED");
            }
            public void CreateFixedRoot()
            {
                owner.CreateCalls++;
                owner.AllParentsHeldAtCreate=true;
                for(var directory=new DirectoryInfo(path);directory is not null;directory=directory.Parent)
                    owner.AllParentsHeldAtCreate&=owner.held.GetValueOrDefault(directory.FullName)>0;
                if(!owner.AllParentsHeldAtCreate)throw new Exception("Parent pin missing before creation");
                owner.OnCreate?.Invoke();
                if(owner.objects.ContainsKey(owner.Api.PhysicalRoot))return;
                owner.CreatedUnderParent=original.ObjectIdentity;
                owner.AddRoot(unsafeSecurity:owner.UnsafeInheritance);owner.Created++;
            }
            public void Dispose()=>owner.CreatorDisposed=true;
        }
    }
}
