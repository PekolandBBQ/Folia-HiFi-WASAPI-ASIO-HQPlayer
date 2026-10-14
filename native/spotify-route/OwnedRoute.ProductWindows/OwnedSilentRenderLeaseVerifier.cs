using System.Diagnostics;
using Folia.ProductRoute;
using Folia.RouteObservation;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

// Own a handle to the exact capture child incarnation. This is no process-name
// exception and grants no authority to other sessions from the same executable.
internal sealed class OwnedSilentRenderLeaseVerifier : IDisposable
{
    private readonly Process process;
    private OwnedSilentRenderLeaseProof proof;
    internal OwnedSilentRenderLeaseProof Proof => proof;
    private readonly string image;
    internal OwnedSilentRenderSession Session { get; }
    private OwnedSilentRenderLeaseVerifier(Process process, OwnedSilentRenderLeaseProof proof, string image)
    {
        this.process = process; this.proof = proof; this.image = image;
        Session = new(proof.EndpointId, proof.SessionInstanceId, proof.GroupingId, checked((uint)proof.ProcessId));
    }
    internal static OwnedSilentRenderLeaseVerifier Bind(OwnedSilentRenderLeaseProof proof)
    {
        if (!OperatingSystem.IsWindows()) throw new RouteBlockedException("WINDOWS_REQUIRED");
        var routeImage = Environment.ProcessPath ?? throw new RouteBlockedException("PRODUCT_IMAGE_REQUIRED");
        var image = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(routeImage)!, "..", "spotify-cable", "folia-capture.exe"));
        var process = Process.GetProcessById(proof.ProcessId);
        try
        {
            _ = process.Handle;
            var result = new OwnedSilentRenderLeaseVerifier(process, proof, image);
            result.RequireLive(); return result;
        }
        catch { process.Dispose(); throw; }
    }
    internal bool Live
    {
        get
        {
            try { RequireLive(); return true; }
            catch { return false; }
        }
    }
    internal void RequireLive()
    {
        if (process.HasExited || process.Id != proof.ProcessId || Supervisor.ProcessBirth(process) != proof.StartedAtUtcTicks ||
            !string.Equals(process.MainModule?.FileName, image, StringComparison.OrdinalIgnoreCase))
            throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_LOST");
    }
    internal void RebindGeneration(OwnedSilentRenderLeaseProof next)
    {
        RequireLive();
        proof.RequireSeekRebind(next);
        proof = next;
    }
    public void Dispose() => process.Dispose();
}
