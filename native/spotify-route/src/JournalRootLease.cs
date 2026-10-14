using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal static class JournalIdentity
{
    internal static string Format(uint volume,uint high,uint low)=>$"{volume:X8}:{high:X8}{low:X8}";
    internal static bool Valid(string? id)=>id is {Length:25} && id[8]==':' &&
        id.Where((_,index)=>index!=8).All(Uri.IsHexDigit) && id[9..]!="0000000000000000";
}

internal sealed record JournalAce(byte Type,byte Flags,uint Mask,string Sid);
internal sealed record JournalSecurityDescriptor(string Owner,bool DaclPresent,JournalAce[]? Aces,ushort Control=0)
{
    internal string Digest=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
        Owner+"|"+DaclPresent+"|"+Control+"|"+(Aces==null?"NULL":string.Join(";",Aces.Select(a=>$"{a.Type},{a.Flags},{a.Mask:X8},{a.Sid}"))))));
}

// This deliberately supports a small NTFS descriptor profile. Unknown ACE
// semantics fail as unsupported, never as an invitation to repair the ACL.
internal static class JournalSecurity
{
    internal const string Policy="local-ntfs-owner-dacl-v1";
    private const string SystemSid="S-1-5-18",Administrators="S-1-5-32-544";
    private const string TrustedInstaller="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    private static bool Trusted(string sid,string user)=>sid==user || sid is SystemSid or Administrators or TrustedInstaller;
    internal static void Require(JournalSecurityDescriptor value,string user,bool directory,bool applicationObject)
    {
        if((value.Control&0x40C0)!=0)
            throw new JournalUnavailableException("JOURNAL_SECURITY_UNSUPPORTED_DESCRIPTOR_CONTROL");
        if(string.IsNullOrWhiteSpace(value.Owner) || (applicationObject?value.Owner!=user:!Trusted(value.Owner,user)))
            throw new JournalUnavailableException("JOURNAL_SECURITY_UNSAFE_OWNER:"+value.Owner);
        if(!value.DaclPresent || value.Aces==null) throw new JournalUnavailableException("JOURNAL_SECURITY_UNSAFE_NULL_DACL");
        var denies=new Dictionary<string,uint>(StringComparer.Ordinal);
        // Creation of unrelated siblings cannot replace an existing pinned
        // directory or the exclusive CreateNew leaf. DELETE_CHILD can.
        uint dangerous=0x000D0110u | (directory?0x40u:0x6u);
        foreach(var ace in value.Aces)
        {
            if(ace.Type>1 || (ace.Flags&~0x1F)!=0 || string.IsNullOrWhiteSpace(ace.Sid))
                throw new JournalUnavailableException("JOURNAL_SECURITY_UNSUPPORTED_ACE");
            uint mask=MapGeneric(ace.Mask);
            if((mask&~0x001F01FFu)!=0) throw new JournalUnavailableException("JOURNAL_SECURITY_UNSUPPORTED_ACCESS_MASK");
            if((ace.Flags&8)!=0) continue; // INHERIT_ONLY: actual children are checked independently.
            if(ace.Type==1)
            {
                denies[ace.Sid]=denies.GetValueOrDefault(ace.Sid)|mask;
                continue;
            }
            if(Trusted(ace.Sid,user)) continue;
            // Only a preceding same-SID deny is sufficient without evaluating
            // group memberships. Even Everyone has special anonymous-token
            // semantics; a cross-SID interaction is unsupported, not certified
            // safe and not mislabeled as a proven effective writer.
            var remaining=mask & dangerous & ~denies.GetValueOrDefault(ace.Sid);
            if(remaining!=0)
            {
                if(denies.Any(deny=>deny.Key!=ace.Sid && (deny.Value&remaining)!=0))
                    throw new JournalUnavailableException("JOURNAL_SECURITY_UNSUPPORTED_DENY_INTERACTION");
                throw new JournalUnavailableException($"JOURNAL_SECURITY_UNSAFE_GRANT:{ace.Sid}:0x{remaining:X8}");
            }
        }
    }
    internal static uint MapGeneric(uint mask)
    {
        uint result=mask&0x0FFFFFFF;
        if((mask&0x80000000)!=0) result|=0x00120089;
        if((mask&0x40000000)!=0) result|=0x00120116;
        if((mask&0x20000000)!=0) result|=0x001200A0;
        if((mask&0x10000000)!=0) result|=0x001F01FF;
        return result;
    }
}

internal sealed record JournalObjectInfo(JournalGuard.DirectoryIdentity Identity,uint Links,uint FileType,
    string FileSystem,uint FileSystemFlags,uint DriveType,bool CaseSensitive,JournalSecurityDescriptor Security)
{
    internal string ObjectIdentity=>JournalIdentity.Format(Identity.Volume,Identity.High,Identity.Low);
    internal void RequireSupported()
    {
        if(FileType!=1 || DriveType!=3 || FileSystem!="NTFS" || (FileSystemFlags&8)==0)
            throw new JournalUnavailableException("JOURNAL_FILESYSTEM_UNSUPPORTED_LOCAL_NTFS_PERSISTENT_ACLS_REQUIRED");
        if(CaseSensitive) throw new JournalUnavailableException("JOURNAL_CASE_SENSITIVE_DIRECTORY_UNSUPPORTED");
    }
}

internal interface IJournalDirectoryPin:IDisposable { JournalObjectInfo Read(); }
internal interface IJournalRootProbe
{
    JournalStorageBinding Resolve();
    IJournalDirectoryPin OpenDirectory(string path);
    JournalObjectInfo ReadLeaf(SafeFileHandle handle);
}

// Owns all pins across both worker lifetimes when held by the supervisor.
// No directory creation, ACL writes, privilege changes or guessed target paths.
internal sealed class JournalRootLease:IDisposable
{
    private sealed record Pin(IJournalDirectoryPin Handle,string Path,JournalObjectInfo Original,bool ApplicationRoot);
    private readonly IJournalRootProbe probe;
    private readonly List<Pin> pins=[];
    private readonly JournalStorageBinding api;
    private bool disposed;
    internal JournalStorageBinding Binding {get;private set;}
    private JournalRootLease(IJournalRootProbe probe,JournalStorageBinding api) {this.probe=probe;this.api=api;Binding=api;}
    internal static JournalRootLease Acquire(IJournalRootProbe probe,JournalStorageBinding? expected=null)
    {
        var api=probe.Resolve();
        var lease=new JournalRootLease(probe,api);
        try
        {
            var anchorPath=Path.GetDirectoryName(api.LogicalRoot)??throw new JournalUnavailableException("JOURNAL_ANCHOR_REQUIRED");
            JournalObjectInfo? anchor=null;
            foreach(var path in Ancestors(anchorPath)) anchor=lease.PinDirectory(path,path,false);
            // The one intentional discovery open. Its final name is only a
            // candidate until the separately opened physical chain matches.
            var logicalHandle=probe.OpenDirectory(api.LogicalRoot);
            JournalObjectInfo logical;
            try
            {
                logical=logicalHandle.Read();
                logical.RequireSupported();
                if(logical.Identity.FinalPath==null) throw new JournalUnavailableException("JOURNAL_ROOT_FINAL_PATH_REQUIRED");
                JournalGuard.CheckDirectory(logical.Identity,logical.Identity.FinalPath);
                JournalSecurity.Require(logical.Security,api.UserSid,true,true);
                lease.pins.Add(new(logicalHandle,logical.Identity.FinalPath,logical,true));
            }
            catch {logicalHandle.Dispose();throw;}
            var candidate=Candidate(api,logical.Identity.FinalPath!);
            JournalObjectInfo? physical=null,physicalAnchor=null;
            foreach(var path in Ancestors(candidate.PhysicalRoot))
            {
                physical=lease.PinDirectory(path,path,JournalPath.SamePath(path,candidate.PhysicalRoot));
                if(JournalPath.SamePath(path,anchorPath)) physicalAnchor=physical;
                if(physical.Identity.Volume!=anchor!.Identity.Volume)
                    throw new JournalUnavailableException("JOURNAL_PHYSICAL_CHAIN_VOLUME_CHANGED");
            }
            if(physicalAnchor==null) throw new JournalUnavailableException("JOURNAL_PHYSICAL_CHAIN_MISSING_ANCHOR");
            JournalGuard.RequireSameDirectory(anchor!.Identity,physicalAnchor.Identity);
            JournalGuard.RequireSameDirectory(logical.Identity,physical!.Identity);
            // Reopen while all first-pass pins are still live. A mapping drift
            // between the discovery and physical walk must not be adopted.
            var repeated=lease.PinDirectory(api.LogicalRoot,candidate.PhysicalRoot,true);
            JournalGuard.RequireSameDirectory(logical.Identity,repeated.Identity);
            var digest=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n",lease.pins.Select(
                p=>$"{p.Path.ToUpperInvariant()}|{p.Original.ObjectIdentity}|{p.Original.Security.Digest}")))));
            lease.Binding=candidate with {AnchorIdentity=anchor.ObjectIdentity,RootIdentity=physical.ObjectIdentity,
                SecurityPolicy=JournalSecurity.Policy,IdentityVersion=1,AncestryDigest=digest,ApiTargetRoot=api.PhysicalRoot};
            lease.Binding.RequireObjectProof();
            lease.Validate();
            if(expected!=null) {expected.RequireObjectProof();JournalStorageBinding.RequireSameContext(lease.Binding,expected);}
            return lease;
        }
        catch {lease.Dispose();throw;}
    }
    internal static JournalStorageBinding Candidate(JournalStorageBinding api,string finalPath)
    {
        if(finalPath.StartsWith(@"\\?\",StringComparison.Ordinal)) finalPath=finalPath[4..];
        if(!Path.IsPathFullyQualified(finalPath) || finalPath.Split([Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar])
            .Any(part=>part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ')))
            throw new JournalUnavailableException("JOURNAL_ROOT_CANDIDATE_SHAPE_UNSAFE");
        var path=Path.GetFullPath(finalPath);
        if(!JournalPath.SamePath(path,finalPath) || !string.Equals(Path.GetFileName(path),"FoliaRouteTrial",StringComparison.OrdinalIgnoreCase))
            throw new JournalUnavailableException("JOURNAL_ROOT_CANDIDATE_SHAPE_UNSAFE");
        var local=Path.GetDirectoryName(api.LogicalRoot)!;
        return JournalStorageBinding.FromApiResults(local,Path.GetDirectoryName(path)!,api.PackageFamily,api.UserSid);
    }
    private static IEnumerable<string> Ancestors(string path)
    {
        var all=new List<string>();for(var d=new DirectoryInfo(path);d!=null;d=d.Parent) all.Add(d.FullName);
        all.Reverse();return all;
    }
    private JournalObjectInfo PinDirectory(string requested,string expected,bool appRoot)
    {
        var handle=probe.OpenDirectory(requested);
        try
        {
            var info=handle.Read();Check(info,expected,appRoot);
            pins.Add(new(handle,expected,info,appRoot));return info;
        }
        catch {handle.Dispose();throw;}
    }
    private void Check(JournalObjectInfo info,string path,bool root,JournalObjectInfo? original=null)
    {
        info.RequireSupported();JournalGuard.CheckDirectory(info.Identity,path,original?.Identity);
        JournalSecurity.Require(info.Security,api.UserSid,true,root);
        if(original!=null && info.Security.Digest!=original.Security.Digest)
            throw new JournalUnavailableException("JOURNAL_SECURITY_CHANGED");
    }
    internal void Validate()
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        JournalStorageBinding.RequireSameContext(probe.Resolve(),api);
        foreach(var pin in pins) Check(pin.Handle.Read(),pin.Path,pin.ApplicationRoot,pin.Original);
    }
    internal JournalObjectInfo ReadLeaf(SafeFileHandle handle)
    {Validate();return probe.ReadLeaf(handle);}
    public void Dispose()
    {
        if(disposed) return;disposed=true;
        for(int i=pins.Count-1;i>=0;i--) pins[i].Handle.Dispose();pins.Clear();
    }
}

internal sealed class WindowsJournalRootProbe:IJournalRootProbe
{
    [StructLayout(LayoutKind.Sequential)] private struct FileInfoNative
    {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;
        public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
    private static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfoNative information);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,out uint information,uint size);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)]
    private static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,StringBuilder? name,uint nameSize,out uint serial,out uint maxComponent,out uint flags,StringBuilder system,uint systemSize);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true)] private static extern uint GetDriveTypeW(string root);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern uint GetSecurityInfo(SafeFileHandle handle,uint type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool IsValidSecurityDescriptor(IntPtr descriptor);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetSecurityDescriptorControl(IntPtr descriptor,out ushort control,out uint revision);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool IsValidAcl(IntPtr acl);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool IsValidSid(IntPtr sid);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] private static extern bool ConvertSidToStringSidW(IntPtr sid,out IntPtr text);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    public JournalStorageBinding Resolve()=>JournalStorage.Resolve();
    public IJournalDirectoryPin OpenDirectory(string path)
    {
        RequireDosPath(path);
        var handle=CreateFileW(path,0x00020000|0x80,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
        if(handle.IsInvalid)
        {
            var error=Marshal.GetLastWin32Error();handle.Dispose();
            if(error is 2 or 3) throw new JournalUnavailableException("JOURNAL_DIRECTORY_MISSING_READONLY_PREFLIGHT");
            throw new JournalUnavailableException("JOURNAL_DIRECTORY_OPEN_UNAVAILABLE:"+error);
        }
        return new NativePin(handle);
    }
    private sealed class NativePin(SafeFileHandle handle):IJournalDirectoryPin
    {public JournalObjectInfo Read()=>ReadObject(handle,true);public void Dispose()=>handle.Dispose();}
    public JournalObjectInfo ReadLeaf(SafeFileHandle handle)=>ReadObject(handle,false);
    private static JournalObjectInfo ReadObject(SafeFileHandle handle,bool directory)
    {
        if(handle.IsInvalid || handle.IsClosed || !GetFileInformationByHandle(handle,out var file))
            throw new JournalUnavailableException("JOURNAL_HANDLE_INFORMATION_UNAVAILABLE:"+Marshal.GetLastWin32Error());
        var text=new StringBuilder(32768);var n=GetFinalPathNameByHandleW(handle,text,(uint)text.Capacity,0);
        if(n==0 || n>=text.Capacity) throw new JournalUnavailableException("JOURNAL_HANDLE_PATH_UNAVAILABLE");
        var final=RequireDosPath(text.ToString());
        var fs=new StringBuilder(128);
        if(!GetVolumeInformationByHandleW(handle,null,0,out var serial,out _,out var flags,fs,(uint)fs.Capacity))
            throw new JournalUnavailableException("JOURNAL_FILESYSTEM_INFORMATION_UNAVAILABLE:"+Marshal.GetLastWin32Error());
        if(serial!=file.Volume) throw new JournalUnavailableException("JOURNAL_FILESYSTEM_VOLUME_MISMATCH");
        uint caseFlags=0;
        if(directory && !GetFileInformationByHandleEx(handle,23,out caseFlags,4))
            throw new JournalUnavailableException("JOURNAL_CASE_SENSITIVITY_UNSUPPORTED:"+Marshal.GetLastWin32Error());
        if((caseFlags&~1u)!=0) throw new JournalUnavailableException("JOURNAL_CASE_SENSITIVITY_UNSUPPORTED_FLAGS");
        return new(new(file.Attributes,file.Volume,file.IndexHigh,file.IndexLow,final),file.Links,GetFileType(handle),fs.ToString(),flags,
            GetDriveTypeW(Path.GetPathRoot(final)!),caseFlags!=0,ReadSecurity(handle));
    }
    internal static string RequireDosPath(string path)
    {
        if(path.StartsWith(@"\\?\",StringComparison.Ordinal)) path=path[4..];
        if(path.Length<3 || !char.IsAsciiLetter(path[0]) || path[1]!=':' || path[2]!='\\' || path.Contains('/') ||
            path[2..].Contains(':') || path.Contains('\0')) throw new JournalUnavailableException("JOURNAL_LOCAL_DOS_PATH_REQUIRED");
        foreach(var part in path[3..].Split('\\'))
            if((path.Length>3 && part.Length==0) || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') ||
                part.Any(c=>c<32) || part.IndexOfAny(['<','>','"','|','?','*'])>=0 || IsReservedComponent(part))
                throw new JournalUnavailableException("JOURNAL_AMBIGUOUS_PATH_UNSUPPORTED");
        return path;
    }
    private static bool IsReservedComponent(string part)
    {
        var stem=part.Split('.')[0].ToUpperInvariant();
        return stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
            (stem.Length==4 && (stem.StartsWith("COM",StringComparison.Ordinal)||stem.StartsWith("LPT",StringComparison.Ordinal)) &&
                (stem[3] is >= '1' and <= '9' or '¹' or '²' or '³'));
    }
    private static string Sid(IntPtr sid)
    {
        if(sid==IntPtr.Zero || !IsValidSid(sid) || !ConvertSidToStringSidW(sid,out var text))
            throw new JournalUnavailableException("JOURNAL_SECURITY_SID_UNAVAILABLE");
        try {return Marshal.PtrToStringUni(text)??throw new JournalUnavailableException("JOURNAL_SECURITY_SID_EMPTY");}
        finally {LocalFree(text);}
    }
    private static JournalSecurityDescriptor ReadSecurity(SafeFileHandle handle)
    {
        var error=GetSecurityInfo(handle,1,5,out var owner,out _,out _,out _,out var sd);
        if(error!=0) throw new JournalUnavailableException("JOURNAL_SECURITY_READ_UNAVAILABLE:"+error);
        try
        {
            if(!IsValidSecurityDescriptor(sd) || !GetSecurityDescriptorControl(sd,out var control,out var revision) || revision!=1 ||
                !GetSecurityDescriptorDacl(sd,out var present,out var acl,out _))
                throw new JournalUnavailableException("JOURNAL_SECURITY_DESCRIPTOR_UNSUPPORTED");
            var ownerSid=Sid(owner);
            if(!present || acl==IntPtr.Zero) return new(ownerSid,present,null,control);
            if(!IsValidAcl(acl)) throw new JournalUnavailableException("JOURNAL_SECURITY_ACL_INVALID");
            var aclRevision=Marshal.ReadByte(acl);var size=(ushort)Marshal.ReadInt16(acl,2);var count=(ushort)Marshal.ReadInt16(acl,4);
            if(aclRevision!=2 || size<8 || count>4096) throw new JournalUnavailableException("JOURNAL_SECURITY_ACL_UNSUPPORTED");
            var aces=new List<JournalAce>();int offset=8;
            for(int i=0;i<count;i++)
            {
                if(offset+8>size) throw new JournalUnavailableException("JOURNAL_SECURITY_ACL_INVALID");
                var ptr=IntPtr.Add(acl,offset);var type=Marshal.ReadByte(ptr);var flags=Marshal.ReadByte(ptr,1);var length=(ushort)Marshal.ReadInt16(ptr,2);
                if(length<16 || offset+length>size) throw new JournalUnavailableException("JOURNAL_SECURITY_ACL_INVALID");
                if(type>1) throw new JournalUnavailableException("JOURNAL_SECURITY_UNSUPPORTED_ACE:"+type);
                var subauthorities=Marshal.ReadByte(ptr,9);
                if(16+4*subauthorities!=length) throw new JournalUnavailableException("JOURNAL_SECURITY_SID_LENGTH_UNSUPPORTED");
                aces.Add(new(type,flags,unchecked((uint)Marshal.ReadInt32(ptr,4)),Sid(IntPtr.Add(ptr,8))));offset+=length;
            }
            return new(ownerSid,true,aces.ToArray(),control);
        }
        finally {if(sd!=IntPtr.Zero) LocalFree(sd);}
    }
}
