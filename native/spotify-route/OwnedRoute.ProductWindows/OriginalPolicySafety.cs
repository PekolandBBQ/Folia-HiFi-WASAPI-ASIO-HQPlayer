using Folia.RouteResearch;

namespace Folia.RouteRunner;

internal sealed record OriginalEndpointEvidence(bool Verified, string? PhysicalIdentity = null,
    PhysicalOwnerDiagnostic? Diagnostic = null);
internal sealed record OriginalPolicyBinding(RenderRole Role, string? RawPolicy, string EndpointId, string PhysicalIdentity);

// Decode for verification only. The journal and compensation retain the exact
// native getter string, including null and original casing, without rewriting it.
internal static class OriginalPolicySafety
{
    internal static void RequireRetained(OriginalPolicyBinding[]? bindings, string?[] originals)
    {
        if (bindings is not { Length: 2 } || originals.Length != 3 || bindings.Where((binding, index) =>
            binding.Role != (RenderRole)index || binding.RawPolicy != originals[index] ||
            (binding.RawPolicy is not null && (string.IsNullOrWhiteSpace(binding.EndpointId) || string.IsNullOrWhiteSpace(binding.PhysicalIdentity)))).Any())
            throw new JournalUnavailableException("RECOVERY_ORIGINAL_BINDING_REQUIRED");
    }
    internal static void VerifyRestoration(OriginalPolicyBinding[] bindings, string?[] originals,
        Func<string, EndpointInfo> readEndpoint, Func<EndpointInfo, OriginalEndpointEvidence> readPhysical)
    {
        RequireRetained(bindings, originals);
        foreach (var saved in bindings.Where(value => value.RawPolicy is not null))
        {
            var current = readEndpoint(saved.EndpointId);
            // State 4/NOTPRESENT under exclusive HQ output is not a new policy
            // target. Restoration needs the same physical identity, not playback
            // availability. Null follows the current default and is not pinned.
            if (!string.Equals(current.Id, saved.EndpointId, StringComparison.OrdinalIgnoreCase) || current.Flow != 0)
                throw new RouteBlockedException("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED");
            var physical = readPhysical(current);
            if (!physical.Verified || physical.PhysicalIdentity != saved.PhysicalIdentity)
                throw new RouteBlockedException("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED",
                    (physical.Diagnostic ?? new("owner-identity", "changed")) with
                    { Role = (int)saved.Role, OriginalKind = "explicit" });
        }
    }
    internal static OriginalPolicyBinding[] Verify(string?[] originals, BaseRenderEndpoint target,
        string?[] currentDefaults, EndpointInfo[] endpoints, Func<string, string?> mapPolicy,
        Func<EndpointInfo, OriginalEndpointEvidence> readPhysical,
        OriginalPolicyBinding[]? previous = null, bool allowDefaultFollow = false)
    {
        if (originals.Length != 3 || currentDefaults.Length != 6 || originals.Any(value => value == ""))
            throw new RouteBlockedException("ORIGINAL_POLICY_VALUES_INVALID");
        var result = new List<OriginalPolicyBinding>();
        for (var role = 0; role < 2; role++)
        {
            var raw = originals[role];
            if (allowDefaultFollow && raw is null)
            {
                // Null is a policy to follow Windows, not a physical endpoint.
                // Preserve it exactly even while HQPlayer owns the only DAC.
                result.Add(new((RenderRole)role, null, string.Empty, string.Empty));
                continue;
            }
            var id = raw is null ? currentDefaults[role] : mapPolicy(raw);
            if (string.IsNullOrWhiteSpace(id)) throw new RouteBlockedException("ORIGINAL_POLICY_ENDPOINT_UNRESOLVED");
            var matches = endpoints.Where(value => string.Equals(value.Id, id, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches.Length != 1) throw new RouteBlockedException("ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS");
            var endpoint = matches[0];
            if (endpoint.State != 1 || endpoint.Flow != 0 || endpoint.BaseIdentity.State != "unsupported" ||
                string.Equals(endpoint.Id, target.Id, StringComparison.OrdinalIgnoreCase) ||
                (raw is not null && (endpoint.PolicyValue is null || !string.Equals(raw, endpoint.PolicyValue, StringComparison.OrdinalIgnoreCase))))
                throw new RouteBlockedException("ORIGINAL_ENDPOINT_UNSAFE",
                    new("endpoint-policy", endpoint.State != 1 ? "inactive" : endpoint.Flow != 0 ? "not-render" :
                        string.Equals(endpoint.Id,target.Id,StringComparison.OrdinalIgnoreCase) ? "target-is-original" :
                        endpoint.BaseIdentity.State != "unsupported" ? "virtual-original" : "policy-mismatch",
                        Role:role, OriginalKind:raw is null ? "default" : "explicit",
                        EndpointState:endpoint.State, EndpointFlow:endpoint.Flow,
                        TargetMatch:string.Equals(endpoint.Id,target.Id,StringComparison.OrdinalIgnoreCase),
                        PolicyMatch:raw is null ? null : string.Equals(raw,endpoint.PolicyValue,StringComparison.OrdinalIgnoreCase)));
            var physical = readPhysical(endpoint);
            if (!physical.Verified || string.IsNullOrWhiteSpace(physical.PhysicalIdentity))
                throw new RouteBlockedException("ORIGINAL_PHYSICAL_OWNER_UNPROVEN",
                    (physical.Diagnostic ?? new("owner-identity", "unavailable")) with
                    { Role = role, OriginalKind = raw is null ? "default" : "explicit" });
            var binding = new OriginalPolicyBinding((RenderRole)role, raw, endpoint.Id, physical.PhysicalIdentity);
            // Explicit saved policy must keep resolving to the same physical
            // owner. Null continues to mean whichever safe default is current.
            if (previous is not null && raw is not null &&
                (previous.Length != 2 || previous[role] != binding))
                throw new RouteBlockedException("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED",
                    new("owner-identity", "changed", Role: role, OriginalKind: "explicit"));
            result.Add(binding);
        }
        return result.ToArray();
    }
}
