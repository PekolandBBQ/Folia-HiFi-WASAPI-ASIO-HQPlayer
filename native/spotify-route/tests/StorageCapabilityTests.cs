using Folia.RouteResearch;
using Folia.RouteRunner;
using Microsoft.Win32.SafeHandles;

internal static class StorageCapabilityTests
{
    private const string User="S-1-5-21-1001",Other="S-1-5-21-1002";
    private static JournalSecurityDescriptor Safe(string owner=User)=>new(owner,true,[new(0,0,0x1F01FF,User),new(0,0,0x1F01FF,"S-1-5-18")]);
    private sealed class Probe:IJournalRootProbe
    {
        internal readonly string Local=Path.GetFullPath(Path.Combine(Path.GetTempPath(),"folia-storage-fake","Local"));
        internal readonly Dictionary<string,JournalObjectInfo> Objects=new(StringComparer.OrdinalIgnoreCase);
        internal readonly List<string> Trace=[];
        internal readonly List<Pin> Pins=[];
        internal JournalStorageBinding Api;
        internal string Physical;
        internal int LogicalOpens;
        internal Action<Probe,string>? BeforeOpen;
        internal JournalObjectInfo? Leaf;
        internal Probe(bool redirect=true)
        {
            Api=JournalStorageBinding.FromApiResults(Local,Local,null,User);
            Physical=redirect?Path.Combine(Local,"Packages","Observed.Component","LocalCache","Local","FoliaRouteTrial"):Api.LogicalRoot;
            uint id=1;
            for(var d=new DirectoryInfo(Physical);d!=null;d=d.Parent)
                Objects[d.FullName]=new(new(0x10,0x12345678,0,id++,d.FullName),1,1,"NTFS",8,3,false,
                    Safe(JournalPath.SamePath(d.FullName,Physical)?User:"S-1-5-18"));
        }
        public JournalStorageBinding Resolve() {Trace.Add("resolve");return Api;}
        public IJournalDirectoryPin OpenDirectory(string path)
        {
            Trace.Add("open:"+path);BeforeOpen?.Invoke(this,path);
            string key=path;
            if(JournalPath.SamePath(path,Api.LogicalRoot)) {LogicalOpens++;key=Physical;}
            if(!Objects.ContainsKey(key)) throw new JournalUnavailableException("missing-root");
            var pin=new Pin(this,key);Pins.Add(pin);return pin;
        }
        public JournalObjectInfo ReadLeaf(SafeFileHandle handle)
        {Trace.Add("read-leaf");return Leaf??throw new Exception("No fake leaf");}
        internal sealed class Pin(Probe owner,string key):IJournalDirectoryPin
        {
            internal bool Disposed;
            public JournalObjectInfo Read()
            {if(Disposed) throw new ObjectDisposedException("fake pin");owner.Trace.Add("read:"+key);return owner.Objects[key];}
            public void Dispose() {Disposed=true;owner.Trace.Add("close:"+key);}
        }
        internal void Change(string path,Func<JournalObjectInfo,JournalObjectInfo> change)=>Objects[path]=change(Objects[path]);
        internal string FilePath=>Path.Combine(Physical,"00000000-0000-0000-0000-000000000025.jsonl");
        internal void SetLeaf()=>Leaf=new(new(0,0x12345678,0,1000,FilePath),1,1,"NTFS",8,3,false,Safe());
    }
    internal static int Run()
    {
        int passed=0;
        void Test(string name,Action body) {body();passed++;Console.WriteLine("PASS storage-capability: "+name);}
        void Require(bool value) {if(!value) throw new Exception("Storage capability assertion failed");}
        void Reject(Action body,string? error=null)
        {
            try {body();}
            catch(Exception e) when(e is RouteBlockedException or JournalUnavailableException or ObjectDisposedException)
            {if(error!=null && !e.Message.Contains(error,StringComparison.Ordinal)) throw new Exception("Wrong failure: "+e.Message,e);return;}
            throw new Exception("Unsafe storage accepted");
        }
        Test("rev39 equal API strings and NoPackage accept only after real dual root proof",()=>
        {
            var p=new Probe();using var root=JournalRootLease.Acquire(p);var b=root.Binding;
            Require(p.Api.LogicalRoot==p.Api.PhysicalRoot && b.PhysicalRoot==p.Physical && b.PackageFamily==null && b.PackageIdentityState=="NoPackage");
            Require(b.RedirectedPackageComponent=="Observed.Component" && b.RootIdentity!=null && b.AnchorIdentity!=null && b.IdentityVersion==1);
            Require(p.LogicalOpens==2 && p.Pins.All(x=>!x.Disposed));b.RequireObjectProof();root.Validate();
        });
        Test("ordinary root still independently opened and identity proved",()=>
        {var p=new Probe(false);using var root=JournalRootLease.Acquire(p);Require(p.LogicalOpens==3 && root.Binding.PhysicalRoot==p.Api.LogicalRoot);});
        Test("API strings alone cannot supply runtime proof",()=>Reject(()=>new Probe().Api.RequireObjectProof()));
        Test("missing existing root never creates anything",()=>
        {var p=new Probe();p.Objects.Remove(p.Physical);Reject(()=>JournalRootLease.Acquire(p));Require(p.Pins.All(x=>x.Disposed));});
        Test("parent receipt rechecked independently and pins remain until caller disposes",()=>
        {
            var p=new Probe();var parent=JournalRootLease.Acquire(p);var childProbe=new Probe();
            using(var child=JournalRootLease.Acquire(childProbe,parent.Binding)) Require(child.Binding==parent.Binding);
            Require(p.Pins.All(x=>!x.Disposed));parent.Validate();parent.Dispose();Require(p.Pins.All(x=>x.Disposed));
        });
        foreach(var change in new Func<JournalStorageBinding,JournalStorageBinding>[] {
            b=>b with {RootIdentity="12345678:00000000000000AA"},b=>b with {AnchorIdentity="12345678:00000000000000AA"},
            b=>b with {IdentityVersion=2},b=>b with {SecurityPolicy="different"},b=>b with {AncestryDigest=new string('F',64)},
            b=>b with {UserSid=Other},b=>b with {PackageFamily="Other"},b=>b with {ApiTargetRoot=b.ApiTargetRoot+"-other"}})
            Test("changed parent object receipt blocks child",()=>
            {using var parent=JournalRootLease.Acquire(new Probe());var child=new Probe();Reject(()=>JournalRootLease.Acquire(child,change(parent.Binding)));Require(child.Pins.All(x=>x.Disposed));});
        Test("logical physical same-name different-ID is rejected",()=>
        {
            var p=new Probe();p.BeforeOpen=(probe,path)=>
            {if(path==p.Physical && p.LogicalOpens==1) probe.Change(p.Physical,v=>v with {Identity=v.Identity with {Low=900}});};
            Reject(()=>JournalRootLease.Acquire(p),"IDENTITY_MISMATCH");Require(p.Pins.All(x=>x.Disposed));
        });
        Test("logical mapping drift after physical pin cannot be adopted",()=>
        {
            var p=new Probe();p.BeforeOpen=(probe,path)=>
            {if(path==p.Api.LogicalRoot && p.LogicalOpens==1) probe.Change(p.Physical,v=>v with {Identity=v.Identity with {Low=900}});};
            Reject(()=>JournalRootLease.Acquire(p),"IDENTITY_MISMATCH");
        });
        foreach(var change in new Func<JournalObjectInfo,JournalObjectInfo>[] {
            v=>v with {Identity=v.Identity with {Attributes=0x410}},v=>v with {Identity=v.Identity with {Low=0}},
            v=>v with {Identity=v.Identity with {Volume=22}},v=>v with {Identity=v.Identity with {FinalPath=v.Identity.FinalPath+"-other"}},
            v=>v with {FileSystem="ReFS"},v=>v with {FileSystemFlags=0},v=>v with {DriveType=4},v=>v with {CaseSensitive=true},
            v=>v with {Security=Safe(Other)},v=>v with {Security=new(User,false,null)}})
            Test("unsafe or unsupported physical ancestor blocks and releases all pins",()=>
            {var p=new Probe();p.Change(p.Local,change);Reject(()=>JournalRootLease.Acquire(p));Require(p.Pins.All(x=>x.Disposed));});
        Test("system-owned ancestors accepted and foreign-owned root rejected",()=>
        {var p=new Probe();using(var root=JournalRootLease.Acquire(p)) root.Validate();p.Change(p.Physical,v=>v with {Security=Safe("S-1-5-18")});Reject(()=>JournalRootLease.Acquire(p),"UNSAFE_OWNER");});
        Test("security drift on retained ancestor blocks next storage boundary",()=>
        {var p=new Probe();using var root=JournalRootLease.Acquire(p);p.Change(p.Local,v=>v with {Security=Safe()});Reject(root.Validate,"SECURITY_CHANGED");});
        Test("ID drift on retained ancestor blocks next storage boundary",()=>
        {var p=new Probe();using var root=JournalRootLease.Acquire(p);p.Change(p.Local,v=>v with {Identity=v.Identity with {Low=999}});Reject(root.Validate,"DIRECTORY_CHANGED");});
        Test("current API user drift blocks next storage boundary",()=>
        {var p=new Probe();using var root=JournalRootLease.Acquire(p);p.Api=p.Api with {UserSid=Other};Reject(root.Validate,"CONTEXT_CHANGED");});
        Test("disposed root cannot authorize storage",()=>
        {var root=JournalRootLease.Acquire(new Probe());root.Dispose();Reject(root.Validate);});
        foreach(var path in new Probe().Objects.Keys)
            Test("reparse at each physical ancestry depth blocks: "+path,()=>
            {var p=new Probe();p.Change(path,v=>v with {Identity=v.Identity with {Attributes=0x410}});Reject(()=>JournalRootLease.Acquire(p));Require(p.Pins.All(x=>x.Disposed));});
        foreach(var relative in new[]{"Other/FoliaRouteTrial","Packages/Part/Extra/LocalCache/Local/FoliaRouteTrial","Packages/Part/LocalCache/Local/Other","../Local-other/FoliaRouteTrial"})
            Test("candidate shape cannot broaden eligible root",()=>
            {var p=new Probe();Reject(()=>JournalRootLease.Candidate(p.Api,Path.GetFullPath(Path.Combine(p.Local,relative))));});
        Test("directory sibling creation grants are not mistaken for bound-object replacement",()=>
            JournalSecurity.Require(new(User,true,[new(0,0,6,Other)]),User,true,true));
        foreach(uint right in new uint[]{0x2,0x4,0x10,0x100,0x10000,0x40000,0x80000,0x40000000,0x10000000})
            Test("untrusted leaf modification right blocks: "+right.ToString("X"),()=>
                Reject(()=>JournalSecurity.Require(new(User,true,[new(0,0,right,Other)]),User,false,true),"UNSAFE_GRANT"));
        Test("parent delete-child blocks replacement authority",()=>Reject(()=>JournalSecurity.Require(new(User,true,[new(0,0,0x40,Other)]),User,true,false),"UNSAFE_GRANT"));
        Test("harmless untrusted reads and inherit-only grant accepted on current directory",()=>
            JournalSecurity.Require(new(User,true,[new(0,0,0x80000000,Other),new(0,8,0x10000000,Other)]),User,true,true));
        Test("preceding exact SID deny removes the denied modification bits",()=>
            JournalSecurity.Require(new(User,true,[new(1,0,6,Other),new(0,0,6,Other)]),User,false,true));
        Test("later deny does not erase earlier allowed rights",()=>Reject(()=>
            JournalSecurity.Require(new(User,true,[new(0,0,6,Other),new(1,0,6,Other)]),User,false,true),"UNSAFE_GRANT"));
        Test("unrelated deny cannot authorize an untrusted write",()=>Reject(()=>
            JournalSecurity.Require(new(User,true,[new(1,0,6,"S-1-5-32-545"),new(0,0,6,Other)]),User,false,true),"UNSUPPORTED_DENY_INTERACTION"));
        Test("Everyone deny cannot be assumed to cover anonymous tokens",()=>Reject(()=>
            JournalSecurity.Require(new(User,true,[new(1,0,6,"S-1-1-0"),new(0,0,6,"S-1-5-7")]),User,false,true),"UNSUPPORTED_DENY_INTERACTION"));
        Test("null DACL unsafe differs from unsupported callback ACE",()=>
        {
            Reject(()=>JournalSecurity.Require(new(User,true,null),User,false,true),"UNSAFE_NULL_DACL");
            Reject(()=>JournalSecurity.Require(new(User,true,[new(9,0,0,User)]),User,false,true),"UNSUPPORTED_ACE");
        });
        Test("empty DACL is not a null DACL",()=>JournalSecurity.Require(new(User,true,[]),User,false,true));
        Test("unsupported mask and ACE flags fail closed",()=>
        {
            Reject(()=>JournalSecurity.Require(new(User,true,[new(0,0,0x02000000,User)]),User,false,true),"UNSUPPORTED");
            Reject(()=>JournalSecurity.Require(new(User,true,[new(0,0x40,0,User)]),User,false,true),"UNSUPPORTED");
            Reject(()=>JournalSecurity.Require(new(User,true,[],0x40),User,false,true),"UNSUPPORTED_DESCRIPTOR_CONTROL");
        });
        Test("recovery guard reads supplied leaf only while parent pins remain held",()=>
        {
            var p=new Probe();p.SetLeaf();using var root=JournalRootLease.Acquire(p);var opens=p.Trace.Count(t=>t.StartsWith("open:"));
            using(var guard=new JournalGuard(root,p.FilePath,false,p.Leaf!.ObjectIdentity))
            using(var fakeHandle=new SafeFileHandle((IntPtr)123,false)) {guard.Validate(fakeHandle);Require(guard.FileIdentity==p.Leaf.ObjectIdentity);}
            Require(p.Trace.Count(t=>t.StartsWith("open:"))==opens && p.Pins.All(x=>!x.Disposed));root.Validate();
        });
        foreach(var change in new Func<JournalObjectInfo,JournalObjectInfo>[] {
            v=>v with {Identity=v.Identity with {Attributes=0x400}},v=>v with {Identity=v.Identity with {Attributes=0x10}},
            v=>v with {Identity=v.Identity with {Low=0}},v=>v with {Identity=v.Identity with {Volume=9}},
            v=>v with {Identity=v.Identity with {FinalPath=v.Identity.FinalPath+"other"}},v=>v with {Links=2},
            v=>v with {FileType=2},v=>v with {FileSystem="ReFS"},v=>v with {Security=Safe(Other)},
            v=>v with {Security=new(User,true,[new(0,0,2,Other)])}})
            Test("actual leaf handle must satisfy identity namespace link filesystem and ACL",()=>
            {
                var p=new Probe();p.SetLeaf();using var root=JournalRootLease.Acquire(p);using var guard=new JournalGuard(root,p.FilePath,false);
                using var handle=new SafeFileHandle((IntPtr)123,false);p.Leaf=change(p.Leaf!);Reject(()=>guard.Validate(handle));
            });
        Test("leaf identity and security remain fixed after first validation",()=>
        {
            var p=new Probe();p.SetLeaf();using var root=JournalRootLease.Acquire(p);using var guard=new JournalGuard(root,p.FilePath,false);
            using var handle=new SafeFileHandle((IntPtr)123,false);guard.Validate(handle);p.Leaf=p.Leaf! with {Security=new(User,true,[])};
            Reject(()=>guard.Validate(handle),"SECURITY_CHANGED");
        });
        foreach(var path in new[]{@"\\server\share\x",@"\\?\UNC\server\share",@"\\.\C:\x",@"C:\x:stream",@"C:\x\..\y",@"C:\x.\y",@"C:\x \y",@"C:\x?\y",@"C:\x\\y",@"C:\NUL\y",@"C:\x\COM1.txt",@"C:\x\LPT²"})
            Test("native namespace gate rejects ambiguous or nonlocal name",()=>Reject(()=>WindowsJournalRootProbe.RequireDosPath(path)));
        Test("native namespace gate accepts exact normalized DOS form",()=>Require(WindowsJournalRootProbe.RequireDosPath(@"\\?\C:\Users\A\AppData\Local")==@"C:\Users\A\AppData\Local"));
        return passed;
    }
}
