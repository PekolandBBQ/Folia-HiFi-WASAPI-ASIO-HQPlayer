using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace Folia.RouteResearch;

/// <summary>A durable frame receipt. Every Record access returns a separate snapshot.</summary>
public sealed class RouteJournalCommit
{
    private readonly RouteRecord record;
    internal RouteJournalCommit(RouteRecord record, long committedLength, string frameHash)
    {
        this.record = record with { Roles = record.Roles.ToArray() };
        CommittedLength = committedLength;
        FrameHash = frameHash;
    }
    public RouteRecord Record => record with { Roles = record.Roles.ToArray() };
    public long CommittedLength { get; }
    public string FrameHash { get; }
}

/// <summary>
/// Append-only, exclusively held transaction journal. Flush(true) completes before
/// the optional durable-append callback and before Append returns. Full snapshots,
/// sequence, and hash chaining detect corruption; these hashes are not an
/// authentication boundary against a malicious writer. The installation/host must
/// provision a private, durable parent directory.
/// </summary>
public sealed class FileRouteJournal : IDurableRouteJournal, IDisposable
{
    private sealed record Frame(long Revision, string PreviousHash, string Payload, string Hash);
    private readonly FileStream file;
    private readonly object gate = new();
    private RouteRecord? latest;
    private RouteJournalCommit? firstCommit;
    private RouteJournalCommit? currentCommit;
    private string previousHash = new('0', 64);
    private bool faulted;
    private bool appending;
    private readonly Action<SafeFileHandle>? validateHandle;
    private readonly Action<RouteJournalCommit>? afterDurableAppend;
    private readonly Action<RouteJournalCommit>? validateReadCommit;

    public FileRouteJournal(string path, bool createNew=false, bool mustExist=false,
        Action<SafeFileHandle>? validateHandle=null, Action<RouteJournalCommit>? afterDurableAppend=null,
        Action<RouteJournalCommit>? validateReadCommit=null)
    {
        if(createNew && mustExist) throw new ArgumentException("CONFLICTING_JOURNAL_OPEN_MODES");
        this.validateHandle=validateHandle;
        this.afterDurableAppend=afterDurableAppend;
        this.validateReadCommit=validateReadCommit;
        file = new FileStream(path, createNew?FileMode.CreateNew:mustExist?FileMode.Open:FileMode.OpenOrCreate, FileAccess.ReadWrite,
            FileShare.None, 4096, FileOptions.WriteThrough);
        Initialize();
    }

    /// <summary>
    /// Takes ownership of an already exclusively held, synchronous read/write handle,
    /// including on initialization failure. The host must independently validate that
    /// object and its provenance; a handle does not itself prove either. All other
    /// duplicates must remain idle while this journal owns the shared file position.
    /// Supplying validateReadCommit requires at least one complete frame; it must
    /// accept every complete frame before any torn suffix can be discarded.
    /// </summary>
    public FileRouteJournal(SafeFileHandle ownedHandle, Action<SafeFileHandle> validateHandle,
        Action<RouteJournalCommit>? afterDurableAppend=null, Action<RouteJournalCommit>? validateReadCommit=null)
    {
        ArgumentNullException.ThrowIfNull(ownedHandle);
        try
        {
            ArgumentNullException.ThrowIfNull(validateHandle);
            this.validateHandle=validateHandle;
            this.afterDurableAppend=afterDurableAppend;
            this.validateReadCommit=validateReadCommit;
            file = new FileStream(ownedHandle, FileAccess.ReadWrite, 4096, isAsync:false);
        }
        catch { ownedHandle.Dispose(); throw; }
        Initialize();
    }

    private void Initialize()
    {
        try
        {
            ValidateStorage();
            if(file.Length>16*1024*1024) throw new JournalUnavailableException("JOURNAL_SIZE_LIMIT");
            // DuplicateHandle shares the OS file position, often left at EOF. Never
            // interpret that position as an empty chain and truncate committed frames.
            file.Seek(0, SeekOrigin.Begin);
            ReadFrames();
        }
        catch { file.Dispose(); throw; }
    }

    public RouteRecord? ReadLatest() { lock(gate) return latest is null ? null : Clone(latest); }
    public RouteJournalCommit? ReadCurrentCommit() { lock(gate) return currentCommit; }
    public RouteJournalCommit? ReadFirstCommit() { lock(gate) return firstCommit; }

    /// <summary>
    /// Pins the journal's handle for a synchronous inspection/duplication callback.
    /// The temporary wrapper does not own the handle and is invalid after return.
    /// Do not retain it, change its file position, or perform journal I/O through it.
    /// </summary>
    public T WithBorrowedHandle<T>(Func<SafeFileHandle,T> inspect)
    {
        ArgumentNullException.ThrowIfNull(inspect);
        lock(gate)
        {
            var held=file.SafeFileHandle;
            var added=false;
            try
            {
                held.DangerousAddRef(ref added);
                using var borrowed=new SafeFileHandle(held.DangerousGetHandle(), ownsHandle:false);
                return inspect(borrowed);
            }
            finally { if(added) held.DangerousRelease(); }
        }
    }

    public void ValidateStorage()
    {
        lock(gate)
        {
            try { validateHandle?.Invoke(file.SafeFileHandle); }
            catch(Exception e) { throw new JournalUnavailableException("JOURNAL_STORAGE_IDENTITY_UNSAFE",e); }
        }
    }

    public void Append(RouteRecord record)
    {
        lock(gate)
        {
            if (faulted) throw new JournalUnavailableException("JOURNAL_FAULT_REOPEN_REQUIRED");
            if (appending)
            {
                faulted=true;
                throw new JournalUnavailableException("JOURNAL_REENTRANT_APPEND");
            }
            ValidateStorage();
            if(file.Length>16*1024*1024) throw new JournalUnavailableException("JOURNAL_SIZE_LIMIT");
            var snapshot=Clone(record);
            OwnedRouteTransaction.ValidateRecord(snapshot);
            if (snapshot.Revision != (latest?.Revision ?? 0) + 1)
                throw new JournalUnavailableException("JOURNAL_REVISION_CONFLICT");
            var payload = JsonSerializer.Serialize(snapshot);
            var hash = Hash(previousHash, payload);
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Frame(snapshot.Revision,
                previousHash, payload, hash)) + "\n");
            if(bytes.Length>1_048_576 || file.Length+bytes.Length>16*1024*1024)
                throw new JournalUnavailableException("JOURNAL_SIZE_LIMIT");
            var commit=new RouteJournalCommit(snapshot, file.Length+bytes.Length, hash);
            appending=true;
            try
            {
                try
                {
                    file.Write(bytes);
                    file.Flush(flushToDisk: true); // No callback or successful acknowledgement before this.
                }
                catch { faulted = true; throw; }
                latest = snapshot;
                previousHash = hash;
                currentCommit=commit;
                firstCommit??=commit;
                try
                {
                    afterDurableAppend?.Invoke(commit);
                    if(faulted) throw new JournalUnavailableException("JOURNAL_FAULT_REOPEN_REQUIRED");
                }
                catch(Exception e)
                {
                    // The frame is already durable. Failed publication/retention ACK
                    // forbids subsequent writes; it does not undo or unflush this frame.
                    faulted=true;
                    throw new JournalUnavailableException("JOURNAL_DURABLE_APPEND_CALLBACK_FAILED",e);
                }
            }
            finally { appending=false; }
        }
    }

    private void ReadFrames()
    {
        // A torn final frame was never acknowledged and cannot have authorized a
        // subsequent setter. Discard only that incomplete suffix, never a corrupt
        // complete frame or the journal's last acknowledged write intent.
        long committedLength = 0;
        using var line = new MemoryStream();
        int item;
        while ((item = file.ReadByte()) != -1)
        {
            if (item != '\n')
            {
                if (line.Length >= 1_048_576) throw new JournalUnavailableException("JOURNAL_FRAME_TOO_LARGE");
                line.WriteByte((byte)item);
                continue;
            }
            try
            {
                var frame = JsonSerializer.Deserialize<Frame>(line.ToArray())
                    ?? throw new InvalidDataException("Empty frame");
                if (frame.Revision != (latest?.Revision ?? 0) + 1 || frame.PreviousHash != previousHash ||
                    frame.Hash != Hash(frame.PreviousHash, frame.Payload))
                    throw new InvalidDataException("Frame integrity mismatch");
                var record = JsonSerializer.Deserialize<RouteRecord>(frame.Payload)
                    ?? throw new InvalidDataException("Empty snapshot");
                OwnedRouteTransaction.ValidateRecord(record);
                if (record.Revision != frame.Revision) throw new InvalidDataException("Snapshot revision mismatch");
                var commit=new RouteJournalCommit(record, file.Position, frame.Hash);
                // Host provenance must accept every complete frame before even a
                // torn suffix is trimmed; latest-frame equality alone is insufficient.
                validateReadCommit?.Invoke(commit);
                latest = record;
                previousHash = frame.Hash;
                currentCommit=commit;
                firstCommit??=currentCommit;
            }
            catch (Exception e) { throw new JournalUnavailableException("JOURNAL_CORRUPT_NO_POLICY_WRITES", e); }
            committedLength = file.Position;
            line.SetLength(0);
        }
        if(validateReadCommit is not null && currentCommit is null)
            throw new JournalUnavailableException("JOURNAL_REQUIRED_COMMIT_MISSING");
        if (file.Length != committedLength)
        {
            ValidateStorage();
            file.SetLength(committedLength);
            file.Flush(flushToDisk: true);
        }
        file.Position = committedLength;
    }
    private static string Hash(string previous, string payload) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(previous + "\n" + payload)));
    private static RouteRecord Clone(RouteRecord record) => record with { Roles = record.Roles.ToArray() };
    public void Dispose()
    {
        lock(gate)
        {
            if(appending)
            {
                faulted=true;
                throw new JournalUnavailableException("JOURNAL_DISPOSE_DURING_APPEND");
            }
            file.Dispose();
        }
    }
}
