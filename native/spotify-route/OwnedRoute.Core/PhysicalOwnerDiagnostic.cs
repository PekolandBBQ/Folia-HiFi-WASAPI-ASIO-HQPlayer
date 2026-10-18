namespace Folia.RouteResearch;

// Public failure metadata only. Device identities and the private restoration
// fingerprint never belong in this record. Service boundaries validate enums.
public sealed record PhysicalOwnerDiagnostic(string Stage, string Reason,
    int? Role = null, string? OriginalKind = null, int? Depth = null,
    uint? NativeResult = null, int? Hresult = null, string? Property = null,
    uint? PropertyType = null, uint? PropertyLength = null, string? Bus = null, uint? EndpointState = null, uint? EndpointFlow = null,
    bool? TargetMatch = null, bool? PolicyMatch = null);
