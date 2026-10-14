using System.Runtime.InteropServices;

namespace Folia.Capture;

// These counts concern matched VB endpoint states, not installed-driver evidence.
// UnreadableCount also includes an endpoint whose identity could not be read.
public sealed record EndpointInventoryEvidence(string State, int ActiveCount, int DisabledCount,
    int NotPresentCount, int UnpluggedCount, int UnreadableCount, int? Hresult);
public sealed record EndpointInventory<T>(T[] Endpoints, EndpointInventoryEvidence Diagnostics);

public interface IEndpointProbe<T> : IDisposable
{
    bool Matches { get; }
    int State { get; }
    T Describe();
}

public static class EndpointInventoryReader
{
    public const int Limit = 256;
    public const int Active = 1, Disabled = 2, NotPresent = 4, Unplugged = 8;

    public static bool IsReadFailure(Exception error) => error is COMException or CaptureFailure
        or InvalidOperationException or ArgumentException or UnauthorizedAccessException or InvalidCastException;

    public static int? NativeHresult(Exception error) => error is CaptureFailure failure
        ? failure.NativeHResult : error is COMException or UnauthorizedAccessException ? error.HResult : null;

    public static EndpointInventory<T> Failed<T>(Exception error) => new([], new("failed", 0, 0, 0, 0, 0,
        NativeHresult(error)));

    // Count is read once; every endpoint acquisition/property read/description/disposal is
    // isolated by index. A broken Item must not terminate an IEnumerator before our catch.
    public static EndpointInventory<T> Read<T>(Func<int> count, Func<int, IEndpointProbe<T>> open)
    {
        int total;
        try { total = count(); }
        catch (Exception error) when (IsReadFailure(error)) { return Failed<T>(error); }
        if (total < 0) return Failed<T>(new CaptureFailure("ENDPOINT_COUNT_INVALID"));
        var endpoints = new List<T>();
        var active = 0; var disabled = 0; var absent = 0; var unplugged = 0; var unreadable = 0;
        int? hresult = null;
        for (var index = 0; index < Math.Min(total, Limit); index++)
        {
            try
            {
                using var endpoint = open(index);
                if (!endpoint.Matches) continue;
                var state = endpoint.State;
                if ((state & Disabled) != 0) disabled++;
                if ((state & NotPresent) != 0) absent++;
                if ((state & Unplugged) != 0) unplugged++;
                if (state != Active) continue;
                active++;
                endpoints.Add(endpoint.Describe());
            }
            catch (Exception error) when (IsReadFailure(error))
            {
                unreadable++;
                hresult ??= NativeHresult(error);
            }
        }
        return new(endpoints.ToArray(), new(total > Limit ? "limit" : unreadable == 0 ? "complete" : "partial",
            active, disabled, absent, unplugged, unreadable, hresult));
    }
}
