using Folia.RouteResearch;

namespace Folia.ProductRoute;

// This additive diagnostic describes a bounded getter failure only. It is never
// route authority and cannot carry device IDs, policy values or exception text.
public static class PhysicalOwnerDiagnosticProjection
{
    public static PhysicalOwnerDiagnostic? FromFailure(string? code, PhysicalOwnerDiagnostic? value)
    {
        if(code is not ("ORIGINAL_PHYSICAL_OWNER_UNPROVEN" or "ORIGINAL_EXPLICIT_ENDPOINT_CHANGED") || value is null ||
            !StageAllowed(value.Stage) || !ReasonAllowed(value.Reason) ||
            value.Role is not (null or 0 or 1) || value.OriginalKind is not (null or "default" or "explicit") ||
            value.Depth is not (null or >=0 and <=3) || value.PropertyLength is >4096 ||
            value.Property is not (null or "class-guid" or "hardware-ids" or "service" or "enumerator" or "bus-type" or "device-id") ||
            value.Bus is not (null or "usb" or "hdaudio" or "pci" or "vendor" or "virtual" or "unknown")) return null;
        // Explicit construction keeps the public field set independent of any
        // future private additions to the exception or native probe evidence.
        return new(value.Stage,value.Reason,value.Role,value.OriginalKind,value.Depth,value.NativeResult,value.Hresult,
            value.Property,value.PropertyType,value.PropertyLength,value.Bus);
    }

    private static bool StageAllowed(string? value)=>value is
        "topology-enumerator" or "topology-endpoint" or "topology-activate" or "topology-connector-count" or
        "topology-connector" or "topology-connected" or "topology-adapter-id" or "topology-adapter" or
        "topology-properties" or "topology-instance-id" or "topology-release" or
        "owner-locate" or "owner-device-id" or "owner-class-guid" or "owner-hardware-ids" or "owner-service" or
        "owner-status" or "owner-enumerator" or "owner-bus-type" or "owner-parent" or "owner-identity" or "owner-repeat";

    private static bool ReasonAllowed(string? value)=>value is
        "api-failed" or "unavailable" or "wrong-type" or "malformed" or "out-of-bounds" or "disconnected" or
        "ambiguous" or "unsupported" or "virtual" or "mismatch" or "cycle" or "depth-limit" or
        "not-started" or "has-problem" or "changed" or "release-failed";
}
