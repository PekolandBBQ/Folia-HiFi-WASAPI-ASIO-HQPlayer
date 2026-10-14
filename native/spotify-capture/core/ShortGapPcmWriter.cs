namespace Folia.Capture;

// Wrapper-only packet continuity: preserve received samples and conceal only bounded, known gaps.
public sealed class ShortGapPcmWriter(PcmDeliveryGate delivery)
{
    public const int MaxGapFrames = 4410; // 100 ms at the fixed 44.1 kHz capture rate.
    private readonly byte[] silence = new byte[MaxGapFrames * 8];
    private long? nextPosition;
    private long lastQpc;
    public long ConcealedFrames { get; private set; }
    public long Discontinuities { get; private set; }
    public long LastGapFrames { get; private set; }
    public long ReceivedFrames { get; private set; }
    public bool InitialDiscontinuity { get; private set; }

    public void Accept(ReadOnlySpan<byte> bytes, int frames, long position, long qpc, bool discontinuity)
    {
        if (frames <= 0 || position < 0 || qpc < 0 || position > long.MaxValue - frames
            || !delivery.Discarding && bytes.Length != (long)frames * 8)
            throw new CaptureFailure("CAPTURE_PACKET_INVALID");
        var missing = 0L;
        if (discontinuity)
        {
            if (nextPosition == null) InitialDiscontinuity = true;
            else
            {
                missing = position - nextPosition.Value;
                // Bootstrap proofs stay strict. Unknown/backward positions are not guessed.
                if (delivery.State != "live" || !delivery.StartValidated || qpc <= lastQpc
                    || missing < 0 || missing > MaxGapFrames)
                    throw new CaptureFailure("CAPTURE_DISCONTINUITY");
                Discontinuities++;
                LastGapFrames = missing;
            }
        }
        if (missing > 0)
        {
            if (!delivery.TryWrite(silence.AsSpan(0, checked((int)missing * 8))))
                throw new CaptureFailure("CAPTURE_OVERFLOW");
            ConcealedFrames += missing;
        }
        if (!delivery.Discarding && !delivery.TryWrite(bytes)) throw new CaptureFailure("CAPTURE_OVERFLOW");
        ReceivedFrames += frames;
        nextPosition = position + frames;
        lastQpc = qpc;
    }

    // Called only when an unpublished capture epoch is cut; never carries positions across Seek.
    public void Reset()
    {
        nextPosition = null; lastQpc = 0;
        ConcealedFrames = Discontinuities = LastGapFrames = ReceivedFrames = 0;
        InitialDiscontinuity = false;
    }
}
