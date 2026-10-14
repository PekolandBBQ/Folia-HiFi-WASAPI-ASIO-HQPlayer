using System.Text.Json;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteRunner;

internal sealed record JournalOwnership(string Path,string FileIdentity,JournalStorageBinding? Storage=null);

// Evidence comes only from this parent's authenticated child pipe. A pathname,
// old JOURNAL_CREATED marker, or exit code never grants recovery authority.
internal sealed class RunJournalProof(string? expectedPath,JournalStorageBinding? expectedStorage=null,
    string? runId=null,int? expectedSpotifyPid=null,long? expectedSpotifyStart=null,string? expectedTarget=null,bool explicitRestore=false)
{
    private readonly object gate=new();
    private RetainedJournal? retained;
    private bool invalid,terminal,preparing,observationsClosed;
    internal RetainedJournal? OwnedRetention { get { lock(gate) return retained; } }
    internal RetainedJournal? Retained { get { lock(gate) return invalid?null:retained; } }
    internal bool TerminalValidated { get { lock(gate) return !invalid&&terminal; } }
    internal JournalOwnership? Get()
    { lock(gate) { var p=invalid?null:retained?.Receipt; return p==null?null:new(p.Path,p.FileIdentity,p.Storage); } }
    internal static bool ValidIdentity(string value) => value.Length==25 && value[8]==':' &&
        value.Where((_,index)=>index!=8).All(c=>c is >= '0' and <= '9' or >= 'A' and <= 'F');
    internal static bool ValidHash(string value)=>value.Length==64 && value.All(c=>c is >= '0' and <= '9' or >= 'A' and <= 'F');
    // Compatibility diagnostic only. Never upgrade old markers into authority.
    internal void ObserveLine(string line) { }
    internal void CloseObservations(bool invalidate)
    {lock(gate) {observationsClosed=true;if(invalidate){invalid=true;terminal=false;}}}
    internal RetainedJournal AcceptPrepared(PreparedJournalReceipt receipt,int childPid,long childStarted,string childSid,
        Func<PreparedJournalReceipt,SafeFileHandle> retain)
    {
        lock(gate)
        {
            if(observationsClosed) throw new JournalUnavailableException("JOURNAL_RECEIPT_CHANNEL_CLOSED");
            if(invalid || retained!=null || terminal || preparing)
            {invalid=true;throw new JournalUnavailableException("DUPLICATE_PREPARED_RECEIPT");}
            preparing=true;
        }
        SafeFileHandle? handle=null;
        try
        {
            ValidatePrepared(receipt,childPid,childStarted,childSid);
            var copy=Clone(receipt);
            // Native duplication/metadata reads never hold the proof lock. A
            // bounded supervisor can seal the channel while this is pending.
            handle=retain(copy);
            lock(gate)
            {
                if(observationsClosed || invalid) throw new JournalUnavailableException("JOURNAL_RECEIPT_CHANNEL_CLOSED");
                retained=new RetainedJournal(copy,handle);handle=null;preparing=false;return retained;
            }
        }
        catch {lock(gate) {if(!observationsClosed) invalid=true;preparing=false;}throw;}
        finally {handle?.Dispose();}
    }
    internal void UseRecovery(RetainedJournal original)
    {
        lock(gate)
        {
            if(retained!=null || !original.Receipt.Fresh || original.Receipt.RunId!=runId) throw new JournalUnavailableException("RECOVERY_PROVENANCE_INVALID");
            retained=original;
        }
    }
    private void ValidatePrepared(PreparedJournalReceipt receipt,int pid,long birth,string sid)
    {
        if(expectedPath==null || expectedStorage==null || runId==null || receipt.RunId!=runId || receipt.ChildPid!=pid || receipt.ChildStarted!=birth ||
            receipt.UserSid!=sid || receipt.UserSid!=expectedStorage.UserSid || receipt.HandleValue<=0 || receipt.Fresh==explicitRestore ||
            !ValidIdentity(receipt.FileIdentity) || !JournalPath.SamePath(receipt.Path,expectedPath) ||
            !JournalPath.SamePath(expectedStorage.Bind(receipt.Path),receipt.Path))
            throw new JournalUnavailableException("PREPARED_RECEIPT_BINDING_INVALID");
        expectedStorage.RequireObjectProof(); receipt.Storage.RequireObjectProof();
        JournalStorageBinding.RequireSameContext(receipt.Storage,expectedStorage);
        var commit=receipt.Prepared; var record=commit.Record;
        ValidateCommitShape(commit);
        if(record.Revision!=1 || record.Stage!=RouteStage.Prepared || record.OriginalProcess!=record.CurrentProcess ||
            record.Roles.Any(x=>x.Stage!=RoleStage.Untouched) || record.CurrentProcess.UserSid!=sid ||
            (!explicitRestore && (record.CurrentProcess.Pid!=expectedSpotifyPid || record.CurrentProcess.StartTimeUtcTicks!=expectedSpotifyStart ||
                record.Target.Id!=expectedTarget)))
            throw new JournalUnavailableException("PREPARED_SNAPSHOT_INVALID");
    }
    internal void AcceptTerminal(TerminalJournalReceipt receipt,int pid,long birth,string sid)
    {
        lock(gate)
        {
            if(observationsClosed) throw new JournalUnavailableException("JOURNAL_RECEIPT_CHANNEL_CLOSED");
            try
            {
                var prepared=retained?.Receipt??throw new JournalUnavailableException("TERMINAL_WITHOUT_PREPARED");
                if(invalid || terminal || receipt.RunId!=runId || receipt.ChildPid!=pid || receipt.ChildStarted!=birth || receipt.UserSid!=sid ||
                    receipt.UserSid!=prepared.UserSid || !JournalPath.SamePath(receipt.Path,prepared.Path) || receipt.FileIdentity!=prepared.FileIdentity ||
                    receipt.PreparedHash!=prepared.Prepared.FrameHash || receipt.PreparedLength!=prepared.Prepared.CommittedLength ||
                    receipt.Terminal.Record.CurrentProcess.Pid!=expectedSpotifyPid ||
                    (expectedSpotifyStart.HasValue && receipt.Terminal.Record.CurrentProcess.StartTimeUtcTicks!=expectedSpotifyStart.Value))
                    throw new JournalUnavailableException("TERMINAL_RECEIPT_BINDING_INVALID");
                JournalStorageBinding.RequireSameContext(receipt.Storage,prepared.Storage);
                ValidateTerminalCommit(prepared,receipt.Terminal,receipt.Values);
                terminal=true;
            }
            catch { invalid=true; terminal=false; throw; }
        }
    }
    internal static void ValidateReadCommit(PreparedJournalReceipt prepared,RouteJournalCommit commit)
    {
        var actual=JournalCommitReceipt.From(commit);
        ValidateCommitShape(actual); RequireSameTransaction(prepared,actual.Record);
        if(actual.Record.Revision==1 && (actual.FrameHash!=prepared.Prepared.FrameHash || actual.CommittedLength!=prepared.Prepared.CommittedLength ||
            JsonSerializer.Serialize(actual.Record)!=JsonSerializer.Serialize(prepared.Prepared.Record)))
            throw new JournalUnavailableException("RECOVERY_PREPARED_COMMIT_MISMATCH");
        if(actual.Record.Revision<1 || actual.CommittedLength<prepared.Prepared.CommittedLength)
            throw new JournalUnavailableException("RECOVERY_COMMIT_PRECEDES_PREPARED");
    }
    internal static void RequireSameTransaction(PreparedJournalReceipt prepared,RouteRecord actual)
    {
        var original=prepared.Prepared.Record;
        if(actual.TransactionId!=original.TransactionId || actual.OriginalProcess!=original.OriginalProcess || actual.Target!=original.Target ||
            (prepared.Fresh && actual.CurrentProcess!=original.CurrentProcess) ||
            !actual.Roles.OrderBy(x=>x.Role).Select(x=>(x.Role,x.Original)).SequenceEqual(original.Roles.OrderBy(x=>x.Role).Select(x=>(x.Role,x.Original))))
            throw new JournalUnavailableException("RECOVERY_TRANSACTION_PROVENANCE_CHANGED");
    }
    internal static void ValidateTerminalCommit(PreparedJournalReceipt prepared,JournalCommitReceipt commit,RoleReadback[] values)
    {
        ValidateCommitShape(commit); RequireSameTransaction(prepared,commit.Record);
        if(commit.Record.Stage is not (RouteStage.Restored or RouteStage.RolledBack) || commit.Record.Revision<=prepared.Prepared.Record.Revision ||
            commit.CommittedLength<=prepared.Prepared.CommittedLength || commit.FrameHash==prepared.Prepared.FrameHash || values.Length!=3 ||
            !values.Select(x=>x.Role).Order().SequenceEqual(Enum.GetValues<RenderRole>().Order()) ||
            values.Any(x=>x.Expected!=prepared.Prepared.Record.Roles.Single(r=>r.Role==x.Role).Original || x.Actual!=x.Expected))
            throw new JournalUnavailableException("TERMINAL_DURABLE_COMMIT_OR_ALL_ORIGINAL_READBACK_INVALID");
    }
    private static void ValidateCommitShape(JournalCommitReceipt commit)
    {
        OwnedRouteTransaction.ValidateRecord(commit.Record);
        if(commit.CommittedLength<=0 || commit.CommittedLength>16*1024*1024 || !ValidHash(commit.FrameHash))
            throw new JournalUnavailableException("JOURNAL_COMMIT_RECEIPT_INVALID");
    }
    private static PreparedJournalReceipt Clone(PreparedJournalReceipt value)=>JsonSerializer.Deserialize<PreparedJournalReceipt>(JsonSerializer.Serialize(value))!;
    internal static string? ArgumentValue(string[] args,string name)
    {
        var index=Array.IndexOf(args,name);
        return index>=0 && index+1<args.Length?args[index+1]:null;
    }
}
