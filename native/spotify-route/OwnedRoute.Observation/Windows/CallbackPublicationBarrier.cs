using System.Runtime.CompilerServices;
using System.Diagnostics.CodeAnalysis;
using System.Diagnostics;

[assembly: InternalsVisibleTo("OwnedRoute.Observation.Tests")]

namespace Folia.RouteObservation.Windows;

// Device-free concurrency primitive shared by callback publication, read fences,
// and final teardown. A revision increment alone does not prove the callback's
// retained pointer has been published to the worker yet.
internal sealed class CallbackPublicationQueue<T>
{
    private sealed class Node(T value)
    {
        internal readonly T Value = value;
        internal Node? Next;
    }

    private readonly int capacity;
    private Node? head;
    private int inFlight;
    private int pending;
    private int closed;

    internal CallbackPublicationQueue(int capacity)
    {
        if (capacity < 1) throw new ArgumentOutOfRangeException(nameof(capacity));
        this.capacity = capacity;
    }

    // Enter before any callback invalidation or publication. Once Close returns,
    // a late entrant cannot publish; an already-entered callback remains counted
    // until Exit, including when it publishes after Close.
    internal bool TryEnter()
    {
        if (Volatile.Read(ref closed) != 0) return false;
        Interlocked.Increment(ref inFlight);
        if (Volatile.Read(ref closed) == 0) return true;
        Interlocked.Decrement(ref inFlight);
        return false;
    }

    internal void Exit() => Interlocked.Decrement(ref inFlight);
    internal bool IsIdle => Volatile.Read(ref inFlight) == 0;
    internal int PendingCount => Volatile.Read(ref pending);
    internal void Close() => Interlocked.Exchange(ref closed, 1);

    internal void WaitUntilIdle(TimeSpan timeout, Action ensureHealthy)
    {
        ArgumentNullException.ThrowIfNull(ensureHealthy);
        if (timeout <= TimeSpan.Zero) throw new TimeoutException("CORE_AUDIO_CALLBACK_PUBLICATION_TIMEOUT");
        var started = Stopwatch.GetTimestamp();
        var spin = new SpinWait();
        while (!IsIdle)
        {
            ensureHealthy();
            if (Stopwatch.GetElapsedTime(started) >= timeout)
                throw new TimeoutException("CORE_AUDIO_CALLBACK_PUBLICATION_TIMEOUT");
            spin.SpinOnce();
        }
        ensureHealthy();
    }

    // Called only between successful TryEnter and Exit. False leaves ownership
    // with the producer, which must signal event loss and dispose its extra ref.
    internal bool TryPublish(T value)
    {
        var node = new Node(value);
        if (Interlocked.Increment(ref pending) > capacity)
        {
            Interlocked.Decrement(ref pending);
            return false;
        }
        Node? previous;
        do
        {
            previous = Volatile.Read(ref head);
            node.Next = previous;
        }
        while (Interlocked.CompareExchange(ref head, node, previous) != previous);
        return true;
    }

    internal bool TryTake([MaybeNullWhen(false)] out T value)
    {
        Node? current;
        do
        {
            current = Volatile.Read(ref head);
            if (current is null) { value = default; return false; }
        }
        while (Interlocked.CompareExchange(ref head, current.Next, current) != current);
        Interlocked.Decrement(ref pending);
        value = current.Value;
        return true;
    }
}
