using System.Runtime.InteropServices;
using Folia.ProductRoute;
using Folia.RouteResearch.Native;

namespace Folia.RouteRunner;

// Admission follows the interfaces actually exposed by Windows, independently of the build machine.
internal sealed class WindowsProductAdmission
{
    private readonly Lazy<ProductCapabilities> capabilities;
    private WindowsProductAdmission() { capabilities = new(BuildCapabilities); }
    internal static WindowsProductAdmission Automatic { get; } = new();
    internal ProductCapabilities Capabilities => capabilities.Value;
    private ProductCapabilities BuildCapabilities()
    {
            var blockers = new List<string>();
            AppRouteCapability? runtime = null;
            if (!OperatingSystem.IsWindows()) blockers.Add("WINDOWS_REQUIRED");
            else if (RuntimeInformation.ProcessArchitecture != Architecture.X64) blockers.Add("APP_ROUTE_X64_REQUIRED");
            else
            {
                try
                {
                    runtime = AppRouteProbe.ReadOnly();
                }
                catch (PlatformNotSupportedException e) { blockers.Add(e.Message); }
                catch (COMException) { blockers.Add("APP_ROUTE_READ_UNAVAILABLE"); }
                catch { blockers.Add("APP_ROUTE_INTERFACE_UNAVAILABLE"); }
            }
            // Runtime compatibility is a local interface result, not a claim that every OS was hardware-tested.
            return new(false, true, true, true, true, blockers.ToArray(),
                IntervalIsolation: true, OwnedSilentRenderLease: true, PreparedSelection: true, BoundedPreparationObservation: true, BoundedRestoreObservation: true, IndefiniteHeldPause: true, FreshResumeInterval: true, BoundedPausedHoldObservation: true, PreparedTargetActivity: true, BoundedPausedProofTransfer: true, BoundedSeekPark: true, ProviderRouteLifetime: true,
                RuntimeCompatible: runtime is not null, CompatibilityProfile: AppRouteCompatibility.Profile,
                WindowsBuild: runtime?.WindowsBuild, RouteInterfaceId: runtime?.InterfaceId);
    }
}
