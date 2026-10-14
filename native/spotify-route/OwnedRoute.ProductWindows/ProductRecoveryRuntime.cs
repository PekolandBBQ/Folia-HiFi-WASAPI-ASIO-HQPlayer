using System.Diagnostics;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal static class ProductRecoveryRuntime
{
    internal static int Run(ProductWorkerChannel channel,ProductWorkerStart start,WindowsProductAdmission admission)
    {
        var import=start.Recovery??throw new JournalUnavailableException("RETAINED_RECOVERY_IMPORT_REQUIRED");
        var baseline=start.Baseline??throw new JournalUnavailableException("AUTHENTICATED_RECOVERY_BASELINE_REQUIRED");
        if(import.Prepared.RunId!=start.RunId||!import.Prepared.Fresh||import.HandleValue<=0||
            baseline.Source.Process!=import.Prepared.Prepared.Record.CurrentProcess||baseline.GlobalDefaults.Length!=6)
            throw new JournalUnavailableException("RECOVERY_IMPORT_BINDING_INVALID");
        using var root=JournalStorage.AcquireRoot(start.Storage);
        using var guard=new JournalGuard(root,import.Prepared.Path,false,import.Prepared.FileIdentity);
        using var journal=new FileRouteJournal(new SafeFileHandle(new IntPtr(import.HandleValue),true),
            handle=>{WindowsJournalHandleTransfer.ValidateFileHandle(handle);guard.Validate(handle);},
            validateReadCommit:commit=>RunJournalProof.ValidateReadCommit(import.Prepared,commit));
        var record=journal.ReadLatest()??throw new JournalUnavailableException("RECOVERY_RECORD_REQUIRED");
        if(record.CurrentProcess!=import.Prepared.Prepared.Record.CurrentProcess)
            throw new RouteBlockedException("AUTOMATIC_RECOVERY_EXACT_PROCESS_CHANGED");
        using var context=new WindowsProductRecoveryDependencies(record.CurrentProcess,record.Target,baseline.Selection,
            record.Roles.OrderBy(x=>x.Role).Select(x=>x.Original).ToArray(),baseline.GlobalDefaults,baseline.Source.ForFreshRecovery(),
            admission,channel.CreateSourceControl,baseline.OriginalDestinations);
        // The current live official source must still be ours. If user changed
        // playback or bridge is gone, preserve journal evidence without setters.
        context.PauseOwnedAndVerify();context.VerifyEnvironment();
        var transaction=new OwnedRouteTransaction(context.Resolver,context.EndpointVerifier,context.Observer,journal);
        var terminal=transaction.Restore();
        if(terminal.Stage is not (RouteStage.Restored or RouteStage.RolledBack))return 4;
        context.VerifyEnvironment();
        using var bound=context.Resolver.OpenVerified(terminal.CurrentProcess);
        var values=terminal.Roles.Select(role=>new RoleReadback(role.Role,role.Original,bound.Get(role.Role))).ToArray();
        if(bound.CheckLiveIdentity()!=terminal.CurrentProcess)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");
        var commit=journal.ReadCurrentCommit()??throw new JournalUnavailableException("RECOVERY_TERMINAL_COMMIT_REQUIRED");
        RunJournalProof.ValidateTerminalCommit(import.Prepared,JournalCommitReceipt.From(commit),values);
        using var self=Process.GetCurrentProcess();
        var receipt=new TerminalJournalReceipt(start.RunId,self.Id,Supervisor.ProcessBirth(self),root.Binding.UserSid,
            import.Prepared.Path,guard.FileIdentity,root.Binding,import.Prepared.Prepared.FrameHash,
            import.Prepared.Prepared.CommittedLength,JournalCommitReceipt.From(commit),values);
        channel.PublishTerminalAndAwaitAcceptance(receipt,context.ReadDefaultStatus(),TimeSpan.FromSeconds(2));return 0;
    }
}
