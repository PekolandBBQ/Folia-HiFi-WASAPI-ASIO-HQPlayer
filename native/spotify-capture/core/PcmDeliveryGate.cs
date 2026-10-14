using System;
using System.Threading;
using System.Threading.Tasks;

namespace Folia.Capture;

public sealed class PcmDeliveryGate
{
	private readonly object gate = new object();

	private readonly BoundedPcmRing ring;

	private BoundedPcmRing? prefix;

	private readonly int bootstrapTimeoutMs;

	private readonly Func<long> milliseconds;

	private long? bootstrapStartedAt;

	private long? bootstrapPrefixFrames;

	private long acceptedFrames;

	private bool bootstrapTimedOut;

	private bool overflowed;

	private readonly TaskCompletionSource<bool> deliver = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

	private readonly TaskCompletionSource<bool> startValidation = new(TaskCreationOptions.RunContinuationsAsynchronously);

	private bool startValidated;

	public bool StartValidated { get { lock (gate) return startValidated; } }

	private string state;

	public string? BootstrapDelivery { get; }

	public int CapacityBytes => BufferSnapshot.CapacityBytes;

	public int QueuedBytes => BufferSnapshot.QueuedBytes;

	public long AcceptedFrames
	{
		get
		{
			lock (gate)
			{
				return acceptedFrames;
			}
		}
	}

	public (string State, int CapacityBytes, int QueuedBytes, long? BootstrapPrefixFrames, long AcceptedFrames) BufferSnapshot
	{
		get
		{
			lock (gate)
			{
				int num = prefix?.QueuedBytes ?? 0;
				return (State: state, CapacityBytes: (state == "buffering") ? prefix!.CapacityBytes : (ring.CapacityBytes + num), QueuedBytes: num + ring.QueuedBytes, BootstrapPrefixFrames: bootstrapPrefixFrames, AcceptedFrames: acceptedFrames);
			}
		}
	}

	public string State
	{
		get
		{
			lock (gate)
			{
				return state;
			}
		}
	}

	public bool Discarding
	{
		get
		{
			lock (gate)
			{
				return state == "discarding";
			}
		}
	}

	public PcmDeliveryGate(int capacityBytes, string? bootstrapDelivery = null, int? bootstrapCapacityBytes = null, int bootstrapTimeoutMs = 0, Func<long>? milliseconds = null, bool holdForStartValidation = false)
	{
		bool flag;
		switch (bootstrapDelivery)
		{
		case null:
		case "discard":
		case "buffer":
			flag = true;
			break;
		default:
			flag = false;
			break;
		}
		if (!flag)
		{
			throw new CaptureFailure("INVALID_REQUEST");
		}
		if (bootstrapTimeoutMs < 0 || (bootstrapDelivery != "buffer" && (bootstrapCapacityBytes.HasValue || bootstrapTimeoutMs != 0)))
		{
			throw new CaptureFailure("INVALID_REQUEST");
		}
		BootstrapDelivery = bootstrapDelivery;
		ring = new BoundedPcmRing(capacityBytes);
		if (bootstrapDelivery == "buffer")
		{
			prefix = new BoundedPcmRing(bootstrapCapacityBytes ?? capacityBytes);
		}
		this.bootstrapTimeoutMs = bootstrapTimeoutMs;
		this.milliseconds = milliseconds ?? ((Func<long>)(() => Environment.TickCount64));
		startValidated = !holdForStartValidation;
		if (startValidated) startValidation.TrySetResult(true);
		state = ((bootstrapDelivery == "discard") ? "discarding" : ((!(bootstrapDelivery == "buffer")) ? "live" : "buffering"));
		if (state == "live")
		{
			deliver.TrySetResult(result: true);
		}
	}

	public void StartBootstrapDeadline()
	{
		lock (gate)
		{
			if (state == "closed")
			{
				throw new CaptureFailure("CAPTURE_CLOSED");
			}
			if (!(state != "buffering") && bootstrapTimeoutMs != 0)
			{
				if (bootstrapStartedAt.HasValue)
				{
					throw new CaptureFailure("CAPTURE_STATE_INVALID");
				}
				bootstrapStartedAt = milliseconds();
			}
		}
	}

	public void CheckBootstrapDeadline()
	{
		lock (gate)
		{
			CheckDeadlineLocked();
		}
	}

	private void CheckDeadlineLocked()
	{
		if (state != "buffering" || !bootstrapStartedAt.HasValue || milliseconds() - bootstrapStartedAt.Value < bootstrapTimeoutMs)
		{
			return;
		}
		bootstrapTimedOut = true;
		CloseLocked();
		throw new CaptureFailure("CAPTURE_BOOTSTRAP_TIMEOUT");
	}

	public bool TryWrite(ReadOnlySpan<byte> bytes)
	{
		if (bytes.Length == 0 || bytes.Length % 8 != 0)
		{
			throw new CaptureFailure("CAPTURE_FRAME_INVALID");
		}
		lock (gate)
		{
			if (state == "closed")
			{
				return false;
			}
			CheckDeadlineLocked();
			if (state == "discarding")
			{
				acceptedFrames += bytes.Length / 8;
				return true;
			}
			if (((state == "buffering") ? prefix! : ring).TryWrite(bytes))
			{
				acceptedFrames += bytes.Length / 8;
				return true;
			}
			overflowed = true;
			CloseLocked();
			return false;
		}
	}

	public async ValueTask<int> ReadAsync(Memory<byte> destination, CancellationToken token)
	{
		if (!await startValidation.Task.WaitAsync(token).ConfigureAwait(false)) return 0;
		await deliver.Task.WaitAsync(token).ConfigureAwait(continueOnCapturedContext: false);
		lock (gate)
		{
			if (state == "closed")
			{
				return 0;
			}
			if (prefix != null)
			{
				int num = ((prefix.QueuedBytes != 0) ? prefix.ReadAsync(destination, token).GetAwaiter().GetResult() : 0);
				if (prefix.QueuedBytes == 0)
				{
					prefix.Close();
					prefix = null;
				}
				if (num != 0)
				{
					return num;
				}
			}
		}
		return await ring.ReadAsync(destination, token).ConfigureAwait(continueOnCapturedContext: false);
	}

	public void Promote()
	{
		lock (gate)
		{
			if (state == "closed")
			{
				throw new CaptureFailure(bootstrapTimedOut ? "CAPTURE_BOOTSTRAP_TIMEOUT" : "CAPTURE_CLOSED");
			}
			if (state == "discarding")
			{
				throw new CaptureFailure("CAPTURE_BOOTSTRAP_DISCARD_ONLY");
			}
			if (state != "buffering")
			{
				throw new CaptureFailure("CAPTURE_PROMOTION_INVALID");
			}
			if (!startValidated) throw new CaptureFailure("CAPTURE_START_UNVERIFIED");
			CheckDeadlineLocked();
			bootstrapPrefixFrames = prefix!.QueuedBytes / 8;
			state = "live";
			deliver.TrySetResult(result: true);
		}
	}

    // Only an unpublished bootstrap can establish a new local position epoch.
    // deliver has never completed, so no pipe write can reference this prefix.
    public void CutUnpublishedBootstrap()
    {
        lock (gate)
        {
            CheckDeadlineLocked();
            if (state != "buffering" || prefix == null || !startValidated)
                throw new CaptureFailure("CAPTURE_POSITION_EPOCH_INVALID");
            var capacity = prefix.CapacityBytes;
            prefix.Close(); prefix = new BoundedPcmRing(capacity);
            acceptedFrames = 0; bootstrapPrefixFrames = null; startValidated = false;
            // Preserve the original whole-bootstrap deadline; a cut never buys
            // another 75 seconds or opens the pipe's publication waiter.
        }
    }

	public void ConfirmStartValidation()
	{
		lock (gate)
		{
			if (state == "closed") throw new CaptureFailure(bootstrapTimedOut ? "CAPTURE_BOOTSTRAP_TIMEOUT"
				: overflowed ? "CAPTURE_OVERFLOW" : "CAPTURE_CLOSED");
			CheckDeadlineLocked();
			startValidated = true;
			startValidation.TrySetResult(true);
		}
	}

	public void Close()
	{
		lock (gate)
		{
			CloseLocked();
		}
	}

	private void CloseLocked()
	{
		state = "closed";
		startValidation.TrySetResult(false);
		prefix?.Close();
		prefix = null;
		ring.Close();
		deliver.TrySetResult(result: false);
	}
}
