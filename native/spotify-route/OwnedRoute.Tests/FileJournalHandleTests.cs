using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Folia.RouteResearch;
using Microsoft.Win32.SafeHandles;

// These tests use portable files and simulated policy only. Linux dup/lseek tests
// establish descriptor lifetime/offset facts, not Windows DuplicateHandle, ACL,
// sharing, process provenance, or crash-durability acceptance.
static class FileJournalHandleTests
{
    public static void Run(Action<string,Action> run)
    {
        run("imported journal validates first and reads from zero despite EOF offset", () => WithPath(path =>
        {
            var p=new FakePlatform();
            RouteJournalCommit expected;
            RouteJournalCommit prepared;
            using(var source=new FileRouteJournal(path,createNew:true))
            {
                p.Controller(source).Begin(p.Live,p.Endpoint);
                expected=source.ReadCurrentCommit()!;
                prepared=source.ReadFirstCommit()!;
            }
            var handle=OpenAtEnd(path);
            var validated=false;
            var frames=0;
            using(var imported=new FileRouteJournal(handle, h=>
            {
                if(!validated && OperatingSystem.IsLinux())
                    Check(Offset(h)==expected.CommittedLength,"Validation did not precede the import seek");
                validated=true;
            }, validateReadCommit:_=>frames++))
            {
                Check(validated && frames==expected.Record.Revision,"Import skipped committed frames");
                SameCommit(imported.ReadCurrentCommit()!,expected);
                SameCommit(imported.ReadFirstCommit()!,prepared);
                Check(new FileInfo(path).Length==expected.CommittedLength,"EOF import truncated a committed journal");
                Check(p.Controller(imported).RecoverAndRestore(p.Live).Stage==RouteStage.Restored,"Imported recovery failed");
                Check(p.Values.SequenceEqual(p.Originals),"Imported recovery lost exact originals");
            }
            Check(handle.IsClosed,"Imported journal did not close its owned handle");
        }));

        run("import guard, size and complete-frame corruption failures never truncate", () => WithPath(path =>
        {
            var record=Prepared();
            using(var journal=new FileRouteJournal(path,createNew:true)) journal.Append(record);
            var valid=File.ReadAllBytes(path);
            foreach(var failure in new[] { "guard", "corrupt", "frame-size", "file-size" })
            {
                File.WriteAllBytes(path,valid);
                if(failure=="file-size")
                {
                    using var expand=new FileStream(path,FileMode.Open,FileAccess.Write,FileShare.None);
                    expand.SetLength(16*1024*1024+1L);
                }
                else File.AppendAllText(path,failure=="corrupt" ? "{\"corrupt\":true}\ntorn" :
                    failure=="frame-size" ? new string('x',1_048_577) : "torn");
                var before=File.ReadAllBytes(path);
                var handle=OpenAtEnd(path);
                Throws<JournalUnavailableException>(()=>
                {
                    using var rejected=new FileRouteJournal(handle,_=>
                    { if(failure=="guard") throw new IOException("unsafe-object"); });
                });
                Check(handle.IsClosed,"Failed import leaked owned handle: "+failure);
                Check(SHA256.HashData(File.ReadAllBytes(path)).SequenceEqual(SHA256.HashData(before)),
                    "Failed import changed evidence: "+failure);
            }
        }));

        run("import checks every complete frame provenance before trimming a torn tail", () => WithPath(path =>
        {
            var record=Prepared();
            using(var journal=new FileRouteJournal(path,createNew:true))
            {
                journal.Append(record);
                journal.Append(record with { Revision=2, TransactionId=Guid.NewGuid() });
                journal.Append(record with { Revision=3 }); // Matching latest must not hide the middle frame.
            }
            File.AppendAllText(path,"torn");
            var before=File.ReadAllBytes(path);
            var checkedFrames=0;
            Throws<JournalUnavailableException>(()=>
            {
                using var rejected=new FileRouteJournal(OpenAtEnd(path),_=>{},validateReadCommit:commit=>
                {
                    checkedFrames++;
                    if(commit.Record.TransactionId!=record.TransactionId) throw new IOException("wrong-provenance");
                });
            });
            Check(checkedFrames==2,"Middle-frame provenance was not checked");
            Check(File.ReadAllBytes(path).SequenceEqual(before),"Wrong provenance truncated a torn tail");
        }));

        run("provenance-required import rejects empty or all-torn evidence without trimming", () => WithPath(path =>
        {
            foreach(var content in new[] { "", "{\"incomplete\":" })
            {
                File.WriteAllText(path,content);
                var before=File.ReadAllBytes(path);
                var validations=0;
                var handle=OpenAtEnd(path);
                var error=Throws<JournalUnavailableException>(()=>
                {
                    using var rejected=new FileRouteJournal(handle,_=>{},validateReadCommit:_=>validations++);
                });
                Check(error.Message=="JOURNAL_REQUIRED_COMMIT_MISSING" && validations==0,
                    "Missing Prepared evidence was accepted");
                Check(handle.IsClosed && File.ReadAllBytes(path).SequenceEqual(before),
                    "Missing provenance import leaked or changed the evidence");
            }
        }));

        run("import trims only a torn suffix after accepting all complete receipts", () => WithPath(path =>
        {
            RouteJournalCommit expected;
            using(var journal=new FileRouteJournal(path,createNew:true))
            {
                journal.Append(Prepared());
                expected=journal.ReadCurrentCommit()!;
            }
            File.AppendAllText(path,"{\"incomplete\":");
            var validations=0;
            var readReceipts=0;
            var appended=0;
            using var imported=new FileRouteJournal(OpenAtEnd(path),_=>validations++,
                afterDurableAppend:_=>appended++,validateReadCommit:commit=>
                {
                    readReceipts++;
                    SameCommit(commit,expected);
                    Check(new FileInfo(path).Length>expected.CommittedLength,"Tail trimmed before provenance acceptance");
                });
            Check(validations==2 && readReceipts==1 && appended==0,"Import/tail validation ordering changed");
            Check(new FileInfo(path).Length==expected.CommittedLength,"Torn suffix not isolated");
            SameCommit(imported.ReadCurrentCommit()!,expected);
        }));

        run("file flush failure publishes no receipt and never permits a simulated setter", () => WithPath(path =>
        {
            var callbacks=0;
            using var journal=new FileRouteJournal(path,createNew:true,afterDurableAppend:_=>callbacks++);
            // Test-only deterministic Flush(true) fault. No production flush bypass or
            // injection API is added. Reopening here is solely setup of this fake stream.
            var field=typeof(FileRouteJournal).GetField("file",BindingFlags.Instance|BindingFlags.NonPublic)!;
            ((FileStream)field.GetValue(journal)!).Dispose();
            var failing=new FailingFlushStream(path);
            field.SetValue(journal,failing);
            var p=new FakePlatform();
            Throws<JournalUnavailableException>(()=>p.Controller(journal).Begin(p.Live,p.Endpoint));
            Check(p.Writes.Count==0 && callbacks==0 && journal.ReadCurrentCommit() is null,
                "Failed flush authorized mutation or published a receipt");
            Throws<JournalUnavailableException>(()=>journal.Append(Prepared()));
            Check(failing.FlushAttempts==1,"Faulted journal retried a write/flush");
        }));

        foreach(var failPrepared in new[] { true,false })
            run("durable receipt callback failure blocks simulated setters; Prepared="+failPrepared, () => WithPath(path =>
            {
                var p=new FakePlatform();
                RouteJournalCommit committed;
                using(var journal=new FileRouteJournal(path,createNew:true,afterDurableAppend:receipt=>
                {
                    if(failPrepared || receipt.Record.Roles.Any(x=>x.Stage==RoleStage.ApplyIntent))
                        throw new IOException("retention-ack-lost");
                }))
                {
                    var error=Throws<JournalUnavailableException>(()=>p.Controller(journal).Begin(p.Live,p.Endpoint));
                    Check(error.InnerException is JournalUnavailableException callback &&
                        callback.Message=="JOURNAL_DURABLE_APPEND_CALLBACK_FAILED","Durable callback failure misreported");
                    committed=journal.ReadCurrentCommit() ?? throw new Exception("Already durable receipt lost");
                    Check(p.Writes.Count==0,"Failed receipt callback authorized a setter");
                    Check(committed.Record.Stage==(failPrepared ? RouteStage.Prepared : RouteStage.Applying),
                        "Already durable snapshot lost on callback failure");
                    Check(new FileInfo(path).Length==committed.CommittedLength,"Durable receipt length mismatch");
                    Throws<JournalUnavailableException>(()=>journal.Append(committed.Record with { Revision=committed.Record.Revision+1 }));
                    Check(new FileInfo(path).Length==committed.CommittedLength,"Callback fault allowed a later append");
                }
                using var recovery=new FileRouteJournal(path,mustExist:true);
                SameCommit(recovery.ReadCurrentCommit()!,committed);
                Check(p.Controller(recovery).RecoverAndRestore(p.Live).Stage==RouteStage.Restored && p.Writes.Count==0,
                    "Unapplied durable intent caused a setter during recovery");
            }));

        run("durable callback observes updated immutable snapshots and safe borrowed handle", () => WithPath(path =>
        {
            FileRouteJournal? journal=null;
            RouteJournalCommit? delivered=null;
            SafeFileHandle? temporary=null;
            var input=Prepared();
            var original=input.Roles[0];
            try
            {
                journal=new FileRouteJournal(path,createNew:true,afterDurableAppend:receipt=>
                {
                    delivered=receipt;
                    Check(journal!.ReadLatest()!.Revision==receipt.Record.Revision &&
                        journal.ReadCurrentCommit()==receipt,"Callback preceded state update");
                    journal.WithBorrowedHandle(handle=>
                    {
                        temporary=handle;
                        Check(RandomAccess.GetLength(handle)==receipt.CommittedLength,"Callback preceded physical file write");
                        var last=new byte[1];
                        Check(RandomAccess.Read(handle,last,receipt.CommittedLength-1)==1 && last[0]=='\n',
                            "Callback exposed an incomplete frame");
                        handle.Dispose(); // Disposing the borrowed wrapper must not close the owner.
                        return true;
                    });
                    receipt.Record.Roles[0]=original with { Original="callback-mutation" };
                });
                journal.Append(input);
                input.Roles[0]=original with { Original="caller-mutation" };
                Check(temporary!.IsClosed && journal.ReadLatest()!.Roles[0]==original &&
                    delivered!.Record.Roles[0]==original,"Receipt/caller mutation leaked into committed state");
                var first=journal.ReadFirstCommit()!;
                journal.Append(journal.ReadLatest()! with { Revision=2 });
                Check(first.Record.Revision==1 && journal.ReadCurrentCommit()!.Record.Revision==2,
                    "Immutable first receipt changed with a later append");
            }
            finally { journal?.Dispose(); }
        }));

        run("reentrant durable callback cannot swallow a journal fault and authorize a setter", () => WithPath(path =>
        {
            FileRouteJournal? journal=null;
            var p=new FakePlatform();
            try
            {
                journal=new FileRouteJournal(path,createNew:true,afterDurableAppend:receipt=>
                    Throws<JournalUnavailableException>(()=>journal!.Append(receipt.Record with { Revision=2 })));
                Throws<JournalUnavailableException>(()=>p.Controller(journal).Begin(p.Live,p.Endpoint));
                Check(p.Writes.Count==0 && journal.ReadCurrentCommit()!.Record.Revision==1,
                    "Swallowed reentrant callback fault permitted policy mutation");
            }
            finally { journal?.Dispose(); }
        }));

        if(OperatingSystem.IsLinux())
            run("Linux descriptor duplicate retains ownership and shares EOF offset across import", () => WithPath(path =>
            {
                SafeFileHandle retained;
                RouteJournalCommit expected;
                using(var worker=new FileRouteJournal(path,createNew:true))
                {
                    worker.Append(Prepared());
                    expected=worker.ReadCurrentCommit()!;
                    retained=worker.WithBorrowedHandle(Duplicate);
                }
                using(retained)
                {
                    Check(!retained.IsClosed,"Worker disposal closed retained descriptor");
                    SetOffset(retained,expected.CommittedLength);
                    var recoveryHandle=Duplicate(retained);
                    Check(Offset(recoveryHandle)==expected.CommittedLength,"dup did not retain shared EOF");
                    SetOffset(recoveryHandle,7);
                    Check(Offset(retained)==7,"Descriptor duplicates did not share the OS offset");
                    SetOffset(retained,expected.CommittedLength);
                    using(var recovered=new FileRouteJournal(recoveryHandle,_=>{}))
                    {
                        SameCommit(recovered.ReadCurrentCommit()!,expected);
                        recovered.Append(recovered.ReadLatest()! with { Revision=2 });
                    }
                    Check(recoveryHandle.IsClosed && !retained.IsClosed,"Imported handle disposal affected another owner");
                    Check(RandomAccess.GetLength(retained)>expected.CommittedLength,"Recovery did not append to retained object");
                }
            }));
    }

    private static RouteRecord Prepared()
    {
        var p=new FakePlatform();
        return new RouteRecord(1,1,Guid.NewGuid(),p.Live,p.Live,p.Endpoint,RouteStage.Prepared,
            Enum.GetValues<RenderRole>().Select(role=>new RouteRole(role,p.Originals[(int)role],RoleStage.Untouched)).ToArray(),
            null,DateTimeOffset.UtcNow);
    }
    private static SafeFileHandle OpenAtEnd(string path)
    {
        var handle=File.OpenHandle(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None,FileOptions.WriteThrough);
        if(OperatingSystem.IsLinux()) SetOffset(handle,RandomAccess.GetLength(handle));
        return handle;
    }
    private static SafeFileHandle Duplicate(SafeFileHandle source)
    {
        var value=dup(source);
        if(value<0) throw new IOException("dup failed: "+Marshal.GetLastPInvokeError());
        return new SafeFileHandle((IntPtr)value,ownsHandle:true);
    }
    private static long Offset(SafeFileHandle handle)
    {
        var value=lseek(handle,0,1);
        if(value<0) throw new IOException("lseek failed: "+Marshal.GetLastPInvokeError());
        return value;
    }
    private static void SetOffset(SafeFileHandle handle,long value)
    {
        if(lseek(handle,value,0)!=value) throw new IOException("lseek failed: "+Marshal.GetLastPInvokeError());
    }
    [DllImport("libc",SetLastError=true)] private static extern int dup(SafeFileHandle handle);
    [DllImport("libc",SetLastError=true)] private static extern long lseek(SafeFileHandle handle,long offset,int whence);
    private static void SameCommit(RouteJournalCommit actual,RouteJournalCommit expected) =>
        Check(actual.CommittedLength==expected.CommittedLength && actual.FrameHash==expected.FrameHash &&
            actual.Record.Revision==expected.Record.Revision && actual.Record.TransactionId==expected.Record.TransactionId &&
            actual.Record.Roles.SequenceEqual(expected.Record.Roles),"Committed frame/receipt changed");
    private static void Check(bool condition,string message) { if(!condition) throw new Exception(message); }
    private static T Throws<T>(Action action) where T:Exception
    {
        try { action(); } catch(T error) { return error; }
        throw new Exception("Expected "+typeof(T).Name);
    }
    private static void WithPath(Action<string> action)
    {
        var path=Path.Combine(Path.GetTempPath(),"folia-handle-journal-"+Guid.NewGuid().ToString("N")+".jsonl");
        try { action(path); }
        finally { File.Delete(path); }
    }
    private sealed class FailingFlushStream(string path) : FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None)
    {
        public int FlushAttempts;
        public override void Flush(bool flushToDisk)
        {
            Check(flushToDisk,"Durable append omitted Flush(true)");
            FlushAttempts++;
            throw new IOException("injected-flush-failure");
        }
    }
}
