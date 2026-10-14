using System.Diagnostics;
using Folia.ProductRoute;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

// This is the concrete worker-side durable ownership adapter. It is deliberately
// not connected to Program until product transport and pause/observer qualification
// exist. The old one-shot Supervisor.Run is never used as the product lifecycle.
internal sealed class A025ProductJournalLifetime : IProductRouteLifetime
{
    private readonly JournalRootLease root;
    private readonly JournalGuard guard;
    private readonly FileRouteJournal journal;
    private readonly string path;
    private readonly ProductDiscovery discovery;
    private readonly Action<OwnedPlaybackTarget> verifyPaused;
    private readonly Action verifyDefaults;
    private readonly IProductJournalChannel channel;
    private readonly string?[] frozenGlobalDefaults;
    private readonly Func<ProductDefaultStatus>? readDefaultStatus;
    private readonly Func<bool>? intervalIsolated;
    private readonly OriginalPolicyBinding[] originalDestinations;
    private PreparedJournalReceipt? prepared;
    private bool disposed;
    public IVerifiedSpotifyResolver Resolver {get;}
    public ISelectedEndpointVerifier EndpointVerifier {get;}
    public ISessionObserver Observer {get;}
    public IDurableRouteJournal Journal=>journal;

    internal A025ProductJournalLifetime(ProductDiscovery discovery, IVerifiedSpotifyResolver resolver,
        ISelectedEndpointVerifier endpoints, ISessionObserver observer, Action<OwnedPlaybackTarget> verifyPaused,
        Action verifyDefaults, IProductJournalChannel channel,string?[]? frozenGlobalDefaults=null,Func<ProductDefaultStatus>? readDefaultStatus=null,Func<bool>? intervalIsolated=null,OriginalPolicyBinding[]? originalDestinations=null)
    {
        if(!OperatingSystem.IsWindows())throw new PlatformNotSupportedException("WINDOWS_JOURNAL_ADAPTER_REQUIRED");
        this.discovery=discovery;Resolver=resolver;EndpointVerifier=endpoints;Observer=observer;
        this.verifyPaused=verifyPaused;this.verifyDefaults=verifyDefaults;this.channel=channel;
        this.frozenGlobalDefaults=frozenGlobalDefaults?.ToArray()??[];this.readDefaultStatus=readDefaultStatus;this.intervalIsolated=intervalIsolated;
        this.originalDestinations=originalDestinations?.ToArray()??[];
        OriginalPolicySafety.RequireRetained(this.originalDestinations,discovery.OriginalValues);
        channel.RequireParentAlive();
        root=JournalStorage.AcquireRoot(channel.Storage);
        try
        {
            path=root.Binding.Bind(channel.JournalPath);
            guard=new JournalGuard(root,path,true);
            try {journal=new FileRouteJournal(path,createNew:true,validateHandle:guard.Validate);}
            catch {guard.Dispose();throw;}
        }
        catch {root.Dispose();throw;}
    }
    public void BindLease(string session,int generation,string leaseId)=>channel.BindLease(session,generation,leaseId);
    public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord expected)
    {
        ValidateApplyAuthority();CheckLive();
        if(prepared is not null)throw new JournalUnavailableException("PRODUCT_PREPARED_REPLAY");
        var commit=journal.ReadFirstCommit()??throw new JournalUnavailableException("PRODUCT_PREPARED_DURABLE_COMMIT_REQUIRED");
        if(commit.Record!=expected && System.Text.Json.JsonSerializer.Serialize(commit.Record)!=System.Text.Json.JsonSerializer.Serialize(expected))
            throw new JournalUnavailableException("PRODUCT_PREPARED_SNAPSHOT_MISMATCH");
        if(expected.Stage!=RouteStage.Prepared||expected.Revision!=1||expected.CurrentProcess!=discovery.Identity)
            throw new JournalUnavailableException("PRODUCT_PREPARED_BINDING_INVALID");
        using var self=Process.GetCurrentProcess();
        var receipt=journal.WithBorrowedHandle(handle=>new PreparedJournalReceipt(channel.RunId,self.Id,
            Supervisor.ProcessBirth(self),root.Binding.UserSid,path,guard.FileIdentity,root.Binding,
            handle.DangerousGetHandle().ToInt64(),JournalCommitReceipt.From(commit),true));
        // The implementation MUST send on the authenticated child-only channel,
        // accept only the same-run exact hash ACK, and bound the wait to two seconds.
        var ack=channel.PublishPreparedAndAwaitRetainedAck(receipt,TimeSpan.FromSeconds(2));
        if(ack!=receipt.Prepared.FrameHash)throw new JournalUnavailableException("PRODUCT_PREPARED_ACK_MISMATCH");
        channel.RequireParentAlive();root.Validate();journal.ValidateStorage();prepared=receipt;
        return ToRetention(receipt);
    }
    public void ValidateApplyAuthority()
    {
        try {channel.RequireParentAlive();}
        catch(Exception e) {throw new RouteBlockedException("PRODUCT_PARENT_APPLY_AUTHORITY_LOST:"+e.GetType().Name);}
    }
    public void ValidateOwnership(PreparedRetention retention)
    {
        CheckLive();
        var actual=prepared??throw new JournalUnavailableException("PRODUCT_PREPARED_ACK_REQUIRED");
        if(retention!=ToRetention(actual))throw new JournalUnavailableException("PRODUCT_RETENTION_CHANGED");
        var commit=journal.ReadCurrentCommit()??throw new JournalUnavailableException("PRODUCT_CURRENT_COMMIT_REQUIRED");
        RunJournalProof.ValidateReadCommit(actual,commit);
    }
    public void VerifyPausedSource(OwnedPlaybackTarget expected)
    {
        CheckLive();
        if(expected.Process!=discovery.Identity)throw new RouteBlockedException("PRODUCT_DISCOVERY_CHANGED");
        verifyPaused(expected);verifyDefaults();
        if(prepared is null)
        {
            if(frozenGlobalDefaults.Length!=6)throw new JournalUnavailableException("RECOVERY_DEFAULT_SNAPSHOT_REQUIRED");
            channel.SetRecoveryBaseline(new(frozenGlobalDefaults.ToArray(),expected,discovery.Selection,OriginalDestinations:originalDestinations.ToArray()));
        }
    }
    public void VerifyRestoredTerminal(RouteRecord terminal,PreparedRetention retention)
    {
        ValidateOwnership(retention);
        using var bound=Resolver.OpenVerified(discovery.Identity);
        if(bound.CheckLiveIdentity()!=discovery.Identity)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        var values=terminal.Roles.Select(role=>new RoleReadback(role.Role,role.Original,bound.Get(role.Role))).ToArray();
        if(bound.CheckLiveIdentity()!=discovery.Identity)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        verifyDefaults();
        var commit=journal.ReadCurrentCommit()??throw new JournalUnavailableException("PRODUCT_TERMINAL_COMMIT_REQUIRED");
        var receipt=prepared!;
        RunJournalProof.ValidateTerminalCommit(receipt,JournalCommitReceipt.From(commit),values);
        using var self=Process.GetCurrentProcess();
        var report=new TerminalJournalReceipt(channel.RunId,self.Id,Supervisor.ProcessBirth(self),root.Binding.UserSid,
            path,guard.FileIdentity,root.Binding,receipt.Prepared.FrameHash,receipt.Prepared.CommittedLength,
            JournalCommitReceipt.From(commit),values);
        channel.PublishTerminalAndAwaitAcceptance(report,ReadDefaultStatus(),TimeSpan.FromSeconds(2));
        CheckLive();
    }
    public bool IntervalIsolated=>intervalIsolated?.Invoke()==true;
    public int IntervalGeneration=>0;
    public string? IntervalId=>null;
    public void ArmCaptureInterval(string session,int generation)=>throw new RouteBlockedException("INTERVAL_FENCE_NOT_COMPOSED");
    public ProductDefaultStatus ReadDefaultStatus()=>readDefaultStatus?.Invoke()??throw new JournalUnavailableException("CURRENT_DEFAULT_STATUS_REQUIRED");
    private static PreparedRetention ToRetention(PreparedJournalReceipt p)=>new(p.Prepared.Record.TransactionId,
        p.Prepared.Record.CurrentProcess,p.Prepared.FrameHash,p.Prepared.CommittedLength,p.FileIdentity,true,true,true);
    private void CheckLive()
    {
        ObjectDisposedException.ThrowIf(disposed,this);root.Validate();journal.ValidateStorage();
    }
    public void Dispose()
    {
        if(disposed)return;disposed=true;journal.Dispose();guard.Dispose();root.Dispose();
    }
}

// Transport must be private, nonce-bound and independently authenticated to the
// exact main supervisor process. User JSON input is not this interface.
internal interface IProductJournalChannel
{
    string RunId {get;}
    string JournalPath {get;}
    JournalStorageBinding Storage {get;}
    void RequireParentAlive();
    void SetRecoveryBaseline(ProductRecoveryBaseline baseline);
    void BindLease(string session,int generation,string leaseId);
    string PublishPreparedAndAwaitRetainedAck(PreparedJournalReceipt receipt,TimeSpan deadline);
    void PublishTerminalAndAwaitAcceptance(TerminalJournalReceipt receipt,ProductDefaultStatus defaults,TimeSpan deadline);
}

// Concrete parent-side root pin, duplicate, provenance and single-recovery owner.
// Does not call audio/COM. The future long-lived product transport must own this
// across the mutation child exit and at most one bounded recovery child.
internal sealed class ProductRetainedJournalOwner : IDisposable
{
    private readonly JournalRootLease root;
    private readonly RunJournalProof proof;
    private readonly IJournalHandleTransfer transfer;
    private readonly Process child;
    private RunJournalProof? recoveryProof;
    private Process? recoveryProcess;
    private long recoveryBirth;
    private readonly long childStarted;
    private bool disposed;
    internal ProductRetainedJournalOwner(JournalRootLease ownedRoot, Process child,long childStarted,
        string runId,string journalPath,int spotifyPid,long spotifyStarted,string target,IJournalHandleTransfer? transfer=null)
    {
        root=ownedRoot;this.child=child;this.childStarted=childStarted;this.transfer=transfer??new WindowsJournalHandleTransfer();
        root.Validate();proof=new RunJournalProof(root.Binding.Bind(journalPath),root.Binding,runId,spotifyPid,spotifyStarted,target);
    }
    internal string AcceptPrepared(PreparedJournalReceipt receipt)
    {
        CheckRoot();
        var retained=proof.AcceptPrepared(receipt,child.Id,childStarted,root.Binding.UserSid,value=>
        {
            var handle=transfer.Retain(child,childStarted,root.Binding.UserSid,value.HandleValue);
            try {using var guard=new JournalGuard(root,value.Path,false,value.FileIdentity);guard.Validate(handle);return handle;}
            catch {handle.Dispose();throw;}
        });
        CheckRoot();return retained.Receipt.Prepared.FrameHash;
    }
    internal void AcceptTerminal(TerminalJournalReceipt receipt)
    {
        CheckRoot();WindowsJournalHandleTransfer.Authenticate(child,childStarted,root.Binding.UserSid);
        proof.AcceptTerminal(receipt,child.Id,childStarted,root.Binding.UserSid);
    }
    internal RecoveryJournalImport TransferForSingleRecovery(Process recoveryChild,long recoveryStarted)
    {
        CheckRoot();
        var held=proof.Retained??throw new JournalUnavailableException("PRODUCT_RETAINED_RECOVERY_AUTHORITY_MISSING");
        // No recovery overlaps a live original worker and no path reopen occurs.
        held.ConfirmOriginalExit(child,childStarted);held.ClaimRecovery();
        using(var guard=new JournalGuard(root,held.Receipt.Path,false,held.Receipt.FileIdentity))guard.Validate(held.Handle);
        var handle=transfer.Send(recoveryChild,recoveryStarted,root.Binding.UserSid,held.Handle);
        var prepared=held.Receipt;
        recoveryProof=new RunJournalProof(prepared.Path,root.Binding,prepared.RunId,prepared.Prepared.Record.CurrentProcess.Pid,
            prepared.Prepared.Record.CurrentProcess.StartTimeUtcTicks,prepared.Prepared.Record.Target.Id);
        recoveryProof.UseRecovery(held);recoveryProcess=recoveryChild;recoveryBirth=recoveryStarted;
        return new(handle,prepared);
    }
    internal void AcceptRecoveryTerminal(TerminalJournalReceipt receipt)
    {
        CheckRoot();var process=recoveryProcess??throw new JournalUnavailableException("RECOVERY_CHILD_REQUIRED");
        WindowsJournalHandleTransfer.Authenticate(process,recoveryBirth,root.Binding.UserSid);
        (recoveryProof??throw new JournalUnavailableException("RECOVERY_PROOF_REQUIRED")).AcceptTerminal(receipt,process.Id,recoveryBirth,root.Binding.UserSid);
    }
    internal void SealLateObservations()=>proof.CloseObservations(invalidate:false);
    internal bool TerminalValidated=>proof.TerminalValidated||recoveryProof?.TerminalValidated==true;
    internal bool RetainedForRecovery=>proof.Retained is not null;
    internal bool MayHavePolicyWrites=>HasAcceptedPrepared(proof);
    internal static bool HasAcceptedPrepared(RunJournalProof value)=>value.OwnedRetention is not null;
    internal RouteRecord? PreparedRecord=>proof.Retained?.Receipt.Prepared.Record;
    private void CheckRoot() {ObjectDisposedException.ThrowIf(disposed,this);root.Validate();}
    public void Dispose()
    {
        if(disposed)return;disposed=true;proof.CloseObservations(invalidate:false);
        proof.OwnedRetention?.Dispose();root.Dispose();
    }
}
