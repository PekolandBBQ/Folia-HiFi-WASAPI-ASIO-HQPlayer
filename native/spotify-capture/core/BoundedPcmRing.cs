namespace Folia.Capture;

// Capture never waits for a consumer. A full ring returns false and the owner stops the generation.
public sealed class BoundedPcmRing
{
    private readonly object gate = new();
    private readonly byte[] ring;
    private readonly SemaphoreSlim readable = new(0, 1);
    private int head, count;
    private bool closed;
    public int CapacityBytes => ring.Length;
    public int QueuedBytes { get { lock (gate) return count; } }

    public BoundedPcmRing(int capacityBytes)
    {
        if (capacityBytes <= 0 || capacityBytes % 8 != 0) throw new ArgumentOutOfRangeException(nameof(capacityBytes));
        ring = new byte[capacityBytes];
    }

    public bool TryWrite(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length % 8 != 0) throw new CaptureFailure("CAPTURE_FRAME_INVALID");
        lock (gate)
        {
            if (closed || bytes.Length > ring.Length - count) return false;
            var tail = (head + count) % ring.Length;
            var first = Math.Min(bytes.Length, ring.Length - tail);
            bytes[..first].CopyTo(ring.AsSpan(tail));
            bytes[first..].CopyTo(ring);
            count += bytes.Length;
            Signal();
            return true;
        }
    }

    public async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken cancellationToken)
    {
        if (destination.Length == 0 || destination.Length % 8 != 0) throw new CaptureFailure("CAPTURE_FRAME_INVALID");
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            lock (gate)
            {
                if (closed) return 0;
                if (count > 0)
                {
                    var size = Math.Min(destination.Length, count);
                    var first = Math.Min(size, ring.Length - head);
                    ring.AsMemory(head, first).CopyTo(destination);
                    ring.AsMemory(0, size - first).CopyTo(destination[first..]);
                    // Samples no longer needed by the ring are cleared immediately.
                    Array.Clear(ring, head, first); Array.Clear(ring, 0, size - first);
                    head = (head + size) % ring.Length; count -= size;
                    return size;
                }
            }
            await readable.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    public void Close()
    {
        lock (gate) { closed = true; count = 0; head = 0; Array.Clear(ring); Signal(); }
    }

    private void Signal() { if (readable.CurrentCount == 0) readable.Release(); }
}
