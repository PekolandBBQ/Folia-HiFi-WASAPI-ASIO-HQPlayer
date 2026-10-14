using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

// API-only values remain useful for pure compatibility checks, but runtime IO
// requires the object receipt produced by a live JournalRootLease.
internal sealed record JournalStorageBinding(string LogicalRoot,string PhysicalRoot,string? PackageFamily,string UserSid,string? RedirectedPackageComponent=null,
    string? AnchorIdentity=null,string? RootIdentity=null,string? SecurityPolicy=null,int IdentityVersion=0,string? AncestryDigest=null,string? ApiTargetRoot=null)
{
    public string PackageIdentityState=>PackageFamily==null?"NoPackage":"PackageFamilyName";
    internal static JournalStorageBinding FromApiResults(string logicalLocal,string physicalLocal,string? packageFamily,string userSid)
    {
        static string Local(string value)
        {
            if(string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value) || value.StartsWith(@"\\",StringComparison.Ordinal))
                throw new RouteBlockedException("JOURNAL_KNOWN_FOLDER_LOCAL_PATH_REQUIRED");
            return Path.TrimEndingDirectorySeparator(Path.GetFullPath(value));
        }
        var logical=Local(logicalLocal); var physical=Local(physicalLocal);
        if(string.IsNullOrWhiteSpace(userSid)) throw new RouteBlockedException("JOURNAL_CURRENT_USER_IDENTITY_REQUIRED");
        if(packageFamily!=null && (string.IsNullOrWhiteSpace(packageFamily) || packageFamily.Length>255 ||
            packageFamily.IndexOfAny(['\\','/',':'])>=0 || packageFamily is "." or ".."))
            throw new RouteBlockedException("JOURNAL_PACKAGE_IDENTITY_INVALID");
        string? component=null;
        if(!JournalPath.SamePath(logical,physical))
        {
            var relative=Path.GetRelativePath(logical,physical);
            var parts=relative.Split([Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar],StringSplitOptions.None);
            if(parts.Length!=4 || !string.Equals(parts[0],"Packages",StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(parts[2],"LocalCache",StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(parts[3],"Local",StringComparison.OrdinalIgnoreCase) ||
                string.IsNullOrWhiteSpace(parts[1]) || parts[1].Length>255 || parts[1] is "." or ".." ||
                parts[1].IndexOfAny(['\\','/',':'])>=0 || parts[1].EndsWith('.') || parts[1].EndsWith(' '))
                throw new RouteBlockedException("JOURNAL_KNOWN_FOLDER_TARGET_OUTSIDE_CURRENT_USER_PACKAGE_CACHE");
            component=parts[1];
            // NoPackage is an explicit API result, never an API error. In that
            // branch this component is only an OS-selected path component; it
            // is not a claim of current process package identity. The physical
            // ancestry and logical/physical same-file proof are still mandatory.
            if(packageFamily!=null && !string.Equals(component,packageFamily,StringComparison.Ordinal))
                throw new RouteBlockedException("JOURNAL_KNOWN_FOLDER_TARGET_NOT_CURRENT_PACKAGE");
        }
        return new(Path.Combine(logical,"FoliaRouteTrial"),Path.Combine(physical,"FoliaRouteTrial"),packageFamily,userSid,component);
    }
    internal string Bind(string requestedPath)
    {
        if(!Path.IsPathFullyQualified(requestedPath)) throw new RouteBlockedException("JOURNAL_ABSOLUTE_PATH_REQUIRED");
        var path=Path.GetFullPath(requestedPath);
        var parent=Path.GetDirectoryName(path);
        if(parent==null || (!JournalPath.SamePath(parent,LogicalRoot) && !JournalPath.SamePath(parent,PhysicalRoot)) ||
            Path.GetExtension(path)!=".jsonl" || !Guid.TryParseExact(Path.GetFileNameWithoutExtension(path),"D",out _))
            throw new RouteBlockedException("JOURNAL_REQUIRES_LOCALAPPDATA_FOLIAROUTETRIAL_GUID_JSONL");
        return Path.Combine(PhysicalRoot,Path.GetFileName(path));
    }
    internal static void RequireSameContext(JournalStorageBinding actual,JournalStorageBinding? expected)
    {
        if(expected==null || !JournalPath.SamePath(actual.LogicalRoot,expected.LogicalRoot) ||
            !JournalPath.SamePath(actual.PhysicalRoot,expected.PhysicalRoot) ||
            actual.PackageFamily!=expected.PackageFamily || actual.UserSid!=expected.UserSid ||
            actual.RedirectedPackageComponent!=expected.RedirectedPackageComponent || actual.AnchorIdentity!=expected.AnchorIdentity ||
            actual.RootIdentity!=expected.RootIdentity || actual.SecurityPolicy!=expected.SecurityPolicy || actual.IdentityVersion!=expected.IdentityVersion ||
            actual.AncestryDigest!=expected.AncestryDigest || actual.ApiTargetRoot!=expected.ApiTargetRoot)
            throw new RouteBlockedException("JOURNAL_PROCESS_STORAGE_CONTEXT_CHANGED");
    }
    internal void RequireObjectProof()
    {
        if(IdentityVersion!=1 || SecurityPolicy!=JournalSecurity.Policy || !JournalIdentity.Valid(AnchorIdentity) ||
            !JournalIdentity.Valid(RootIdentity) || AncestryDigest==null || AncestryDigest.Length!=64 ||
            !AncestryDigest.All(Uri.IsHexDigit) || ApiTargetRoot==null)
            throw new RouteBlockedException("JOURNAL_LIVE_ROOT_OBJECT_PROOF_REQUIRED");
    }
}

internal static class JournalStorage
{
    // Documented Windows 10 1703+ flags. Do not combine them, request CREATE,
    // suppress verification, or force a different AppContainer redirection.
    internal const uint NoPackageRedirection=0x00010000,ReturnFilterRedirectionTarget=0x00040000;
    // Isolated live trial: Windows Profile known folder. Original AppData journals remain untouched.
    private static readonly Guid LocalAppData=new("5E6C858F-0E22-4760-9AFE-EA3317B67173");
    // Compatibility metadata only. AcquireRoot is the runtime authority.
    internal static JournalStorageBinding Current=>Resolve();
    internal static JournalRootLease AcquireRoot(JournalStorageBinding? expected=null)
        =>JournalRootLease.Acquire(new WindowsJournalRootProbe(),expected);
    [DllImport("shell32.dll",ExactSpelling=true)]
    private static extern int SHGetKnownFolderPath(in Guid folder,uint flags,IntPtr token,out IntPtr path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
    private static extern int GetCurrentPackageFamilyName(ref uint length,StringBuilder? family);
    private static string KnownFolder(uint flags)
    {
        IntPtr value=IntPtr.Zero;
        try
        {
            var hr=SHGetKnownFolderPath(in LocalAppData,flags,IntPtr.Zero,out value);
            if(hr!=0) throw new RouteBlockedException($"JOURNAL_KNOWN_FOLDER_UNAVAILABLE:flags=0x{flags:X8}:hresult=0x{unchecked((uint)hr):X8}");
            return Marshal.PtrToStringUni(value)??throw new RouteBlockedException("JOURNAL_KNOWN_FOLDER_EMPTY");
        }
        finally { if(value!=IntPtr.Zero) Marshal.FreeCoTaskMem(value); }
    }
    private static string? PackageFamily()
    {
        uint length=0; var result=GetCurrentPackageFamilyName(ref length,null);
        if(IsNoPackageProbe(result,length)) return null;
        var text=new StringBuilder((int)length); result=GetCurrentPackageFamilyName(ref length,text);
        if(result!=0 || length<2 || length>text.Capacity || text.Length==0 || text.Length!=length-1)
            throw new RouteBlockedException("JOURNAL_PACKAGE_IDENTITY_UNAVAILABLE:"+result);
        return text.ToString();
    }
    internal static bool IsNoPackageProbe(int result,uint length)
    {
        if(result==15700) return true; // The only documented NoPackage result.
        if(result!=122 || length<2 || length>256) throw new RouteBlockedException("JOURNAL_PACKAGE_IDENTITY_UNAVAILABLE:"+result);
        return false;
    }
    internal static JournalStorageBinding ResolveFrom(Func<uint,string> knownFolder,Func<string?> packageFamily,Func<string> userSid)
    {
        var family=packageFamily();var sid=userSid();
        var logical=knownFolder(NoPackageRedirection);var physical=knownFolder(ReturnFilterRedirectionTarget);
        // A changing runtime identity or impersonated user cannot supply one
        // half of a binding and then authorize the other half.
        if(family!=packageFamily() || sid!=userSid()) throw new RouteBlockedException("JOURNAL_IDENTITY_CHANGED_DURING_RESOLUTION");
        return JournalStorageBinding.FromApiResults(logical,physical,family,sid);
    }
    internal static JournalStorageBinding Resolve()
    {
        if(!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("WINDOWS_JOURNAL_BINDING_REQUIRED");
        string UserSid()
        {
            using var impersonation=WindowsIdentity.GetCurrent(true);
            if(impersonation!=null) throw new RouteBlockedException("JOURNAL_IMPERSONATION_UNSUPPORTED");
            using var current=WindowsIdentity.GetCurrent();
            return current.User?.Value??throw new RouteBlockedException("JOURNAL_CURRENT_USER_IDENTITY_REQUIRED");
        }
        return ResolveFrom(KnownFolder,PackageFamily,UserSid);
    }
}

internal static class JournalPath
{
    internal static bool SamePath(string left,string right)
    {
        if(left.StartsWith(@"\\?\",StringComparison.Ordinal)) left=left[4..];
        if(right.StartsWith(@"\\?\",StringComparison.Ordinal)) right=right[4..];
        return string.Equals(Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),StringComparison.OrdinalIgnoreCase);
    }
    internal static void Check(JournalStorageBinding storage,string path,bool creating,bool createDirectory)
    {
        if(!SamePath(storage.Bind(path),path)) throw new RouteBlockedException("JOURNAL_PHYSICAL_PATH_REQUIRED");
        for(var p=new DirectoryInfo(storage.PhysicalRoot);p!=null;p=p.Parent)
            if(p.Exists && (p.Attributes&FileAttributes.ReparsePoint)!=0) throw new RouteBlockedException("JOURNAL_REPARSE_PATH_FORBIDDEN");
        if(creating)
        {
            if(File.Exists(path) || Directory.Exists(path)) throw new RouteBlockedException("NEW_JOURNAL_REQUIRED_USE_RESTORE_FOR_EXISTING");
            if(createDirectory) Directory.CreateDirectory(storage.PhysicalRoot); // Existing user ACL inheritance only.
            else if(!Directory.Exists(storage.PhysicalRoot)) throw new RouteBlockedException("JOURNAL_DIRECTORY_MISSING_READONLY_PREFLIGHT");
        }
        else if(!File.Exists(path) || new FileInfo(path).Length==0 || (File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)
            throw new RouteBlockedException("EXISTING_NONEMPTY_REGULAR_JOURNAL_REQUIRED");
    }
}

// All inspection/policy work is inside the continuation. A failed proof cannot
// reach it, and successful ancestry handles remain held until it has finished.
internal static class JournalPathGate
{
    internal static int Run<TGuard>(JournalStorageBinding storage,string? requestedPath,bool createDirectory,
        Func<string,bool,TGuard> acquire,Func<string,TGuard,int> proceed) where TGuard:class,IDisposable
        =>Run(()=>storage,requestedPath,createDirectory,acquire,(_,path,guard)=>proceed(path,guard));
    internal static int Run<TGuard>(Func<JournalStorageBinding> resolve,string? requestedPath,bool createDirectory,
        Func<string,bool,TGuard> acquire,Func<JournalStorageBinding,string,TGuard,int> proceed) where TGuard:class,IDisposable
    {
        string physical; TGuard guard; JournalStorageBinding? storage=null;
        try
        {
            storage=resolve();
            requestedPath??=Path.Combine(storage.LogicalRoot,Guid.NewGuid().ToString("D")+".jsonl");
            physical=storage.Bind(requestedPath); guard=acquire(physical,createDirectory);
        }
        catch(Exception e)
        {
            Evidence.Emit("JOURNAL_PATH_PREFLIGHT_BLOCKED",new { requestedPath,storage,error=e.Message,
                journalCreated=false,readyEmitted=false,policyCalls=0,setters=0,streamInitializations=0 });
            return 2;
        }
        using(guard)
        {
            Evidence.Emit("JOURNAL_PATH_CAPABILITY",new { requestedPath,path=physical,storage,
                ancestryPinned=true,journalCreated=false,writeCapability="not probed; CreateNew and flush still required",setters=0,policyCalls=0,streamInitializations=0 });
            return proceed(storage,physical,guard);
        }
    }
}
