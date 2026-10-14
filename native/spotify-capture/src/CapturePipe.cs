using System.IO.Pipes;

namespace Folia.Capture;

internal sealed class CapturePipe : IDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly CancellationTokenSource cancellation = new();
    private readonly PcmDeliveryGate ring;
    private readonly Action<string, Exception?> fail;
    private Task? writing;
    private long deliveredFrames;
    private int closed;
    internal bool Connected => Volatile.Read(ref closed) == 0 && pipe.IsConnected;
    internal long DeliveredFrames => Interlocked.Read(ref deliveredFrames);

    internal CapturePipe(string name, PcmDeliveryGate ring, Action<string, Exception?> fail)
    {
        this.ring = ring; this.fail = fail;
        // FirstPipeInstance prevents claiming an existing name; CurrentUserOnly prevents cross-user reads.
        pipe = new NamedPipeServerStream(name, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance, 0, 32768);
    }

    internal void Begin() => writing = WriteAsync();

    private async Task WriteAsync()
    {
        var bytes = new byte[32768];
        try
        {
            using var connectionDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
            connectionDeadline.CancelAfter(TimeSpan.FromSeconds(15));
            await pipe.WaitForConnectionAsync(connectionDeadline.Token).ConfigureAwait(false);
            while (!cancellation.IsCancellationRequested)
            {
                var count = await ring.ReadAsync(bytes, cancellation.Token).ConfigureAwait(false);
                if (count == 0) return;
                await pipe.WriteAsync(bytes.AsMemory(0, count), cancellation.Token).ConfigureAwait(false);
                Interlocked.Add(ref deliveredFrames, count / 8);
                Array.Clear(bytes, 0, count);
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (OperationCanceledException error) { fail("CAPTURE_PIPE_CONNECT_TIMEOUT", error); }
        catch (Exception error) when (cancellation.IsCancellationRequested && error is IOException or ObjectDisposedException) { }
        catch (Exception error) { fail("CAPTURE_PIPE_FAILED", error); }
        finally { Array.Clear(bytes); }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        cancellation.Cancel(); ring.Close(); pipe.Dispose();
        // WriteAsync owns its own buffer and token. It cannot access a replacement generation.
        if (writing != null) _ = writing.ContinueWith(_ => cancellation.Dispose(), TaskScheduler.Default);
        else cancellation.Dispose();
    }
}
