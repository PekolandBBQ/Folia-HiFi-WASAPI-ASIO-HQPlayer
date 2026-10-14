using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

// A guard validates the supplied leaf handle against continuously held root
// pins. It never opens the leaf by name, including automatic recovery.
internal sealed class JournalGuard:IDisposable
{
    internal sealed record DirectoryIdentity(uint Attributes,uint Volume,uint High,uint Low,string? FinalPath);
    private readonly JournalRootLease root;
    private readonly bool ownsRoot;
    private readonly string path;
    private readonly string? expectedIdentity;
    private string? identity,securityDigest;
    private bool disposed;
    internal string FileIdentity=>identity??throw new JournalUnavailableException("JOURNAL_IDENTITY_NOT_BOUND");
    internal JournalStorageBinding Storage=>root.Binding;
    internal JournalGuard(string journalPath,bool creating,string? expectedIdentity=null,bool createDirectory=true)
        :this(JournalStorage.AcquireRoot(),journalPath,creating,expectedIdentity,true) { }
    internal JournalGuard(JournalRootLease root,string journalPath,bool creating,string? expectedIdentity=null)
        :this(root,journalPath,creating,expectedIdentity,false) { }
    private JournalGuard(JournalRootLease root,string journalPath,bool creating,string? expectedIdentity,bool ownsRoot)
    {
        this.root=root;this.ownsRoot=ownsRoot;this.expectedIdentity=expectedIdentity;
        try
        {
            root.Binding.RequireObjectProof();root.Validate();path=root.Binding.Bind(journalPath);
            if(expectedIdentity!=null && !JournalIdentity.Valid(expectedIdentity))
                throw new JournalUnavailableException("RECOVERY_FILE_IDENTITY_INVALID");
            // Read-only/pre-create checks cannot create the known-existing root.
            // Existing-handle validation intentionally makes no leaf name query.
            if(creating && (File.Exists(path) || Directory.Exists(path)))
                throw new JournalUnavailableException("NEW_JOURNAL_REQUIRED_USE_RESTORE_FOR_EXISTING");
        }
        catch {if(ownsRoot) root.Dispose();throw;}
    }
    internal void Validate(SafeFileHandle journal)
    {
        ObjectDisposedException.ThrowIf(disposed,this);
        var file=root.ReadLeaf(journal);file.RequireSupported();var info=file.Identity;
        if((info.Attributes&(0x400u|0x10u|0x40u))!=0 || file.Links!=1 || (info.High==0 && info.Low==0) ||
            info.FinalPath==null || !JournalPath.SamePath(info.FinalPath,path) ||
            file.ObjectIdentity[..8]!=root.Binding.RootIdentity![..8])
            throw new JournalUnavailableException("JOURNAL_LEAF_IDENTITY_UNSAFE");
        JournalSecurity.Require(file.Security,root.Binding.UserSid,false,true);
        if(identity!=null && identity!=file.ObjectIdentity) throw new JournalUnavailableException("JOURNAL_FILE_IDENTITY_CHANGED");
        if(securityDigest!=null && securityDigest!=file.Security.Digest) throw new JournalUnavailableException("JOURNAL_SECURITY_CHANGED");
        RequireExpectedIdentity(file.ObjectIdentity,expectedIdentity);
        identity=file.ObjectIdentity;securityDigest=file.Security.Digest;
    }
    internal static void RequireExpectedIdentity(string actual,string? expected)
    {
        if(expected!=null && (!JournalIdentity.Valid(expected) || actual!=expected))
            throw new JournalUnavailableException("RECOVERY_FILE_IDENTITY_MISMATCH");
    }
    internal static void CheckDirectory(DirectoryIdentity actual,string expected,DirectoryIdentity? pinned=null)
    {
        if((actual.Attributes&(0x400u|0x40u))!=0 || (actual.Attributes&0x10)==0 || (actual.High==0 && actual.Low==0) ||
            actual.FinalPath==null || !JournalPath.SamePath(actual.FinalPath,expected))
            throw new JournalUnavailableException("JOURNAL_DIRECTORY_IDENTITY_UNSAFE");
        if(pinned!=null && (actual.Volume!=pinned.Volume || actual.High!=pinned.High || actual.Low!=pinned.Low))
            throw new JournalUnavailableException("JOURNAL_DIRECTORY_CHANGED");
    }
    internal static void RequireSameDirectory(DirectoryIdentity physical,DirectoryIdentity logical)
    {
        if(physical.Volume!=logical.Volume || physical.High!=logical.High || physical.Low!=logical.Low)
            throw new JournalUnavailableException("JOURNAL_LOGICAL_PHYSICAL_IDENTITY_MISMATCH");
    }
    internal void ValidateDirectories() {ObjectDisposedException.ThrowIf(disposed,this);root.Validate();}
    public void Dispose() {if(disposed) return;disposed=true;if(ownsRoot) root.Dispose();}
}
