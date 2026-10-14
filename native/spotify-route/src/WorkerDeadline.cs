namespace Folia.RouteRunner;

// Monotonic parent budget. A valid creation marker starts the short phase once.
// This limits supervision only; Windows may finish a dispatched RPC after exit.
internal sealed class WorkerDeadline(int absoluteLimitMs,int? preparationLimitMs=null,int mutationLimitMs=20_000)
{
    private long journalAt=-1;
    internal void JournalCreated(long elapsedMs)
    {
        if(elapsedMs<0 || elapsedMs>=absoluteLimitMs || (preparationLimitMs is int limit && elapsedMs>=limit)) return;
        Interlocked.CompareExchange(ref journalAt,elapsedMs,-1);
    }
    internal bool Expired(long elapsedMs)
    {
        if(elapsedMs>=absoluteLimitMs) return true;
        if(preparationLimitMs is null) return false;
        var created=Interlocked.Read(ref journalAt);
        return created<0?elapsedMs>=preparationLimitMs.Value:elapsedMs-created>=mutationLimitMs;
    }
}
