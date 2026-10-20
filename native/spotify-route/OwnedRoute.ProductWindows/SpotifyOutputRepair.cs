using System.Diagnostics;
using System.Text.Json;
using Folia.RouteResearch;
using Folia.RouteResearch.Windows;

namespace Folia.RouteRunner;

// native/spotify-route/OwnedRoute.ProductWindows/SpotifyOutputRepair.cs
// Repair stale per-Spotify render policies only. Preserve every prior value in a new append-only record.
internal static class SpotifyOutputRepair
{
    internal static bool NeedsReset(string? raw, EndpointInfo[] endpoints, Func<string,string?> mapPolicy)
    {
        if(raw is null)return false; // System default is a valid nullable policy, including an exclusive DAC.
        var id=mapPolicy(raw);
        var matches=endpoints.Where(e=>string.Equals(e.Id,id,StringComparison.OrdinalIgnoreCase)).ToArray();
        return matches.Length!=1 || matches[0].State!=1 || matches[0].Flow!=0
            || matches[0].BaseIdentity.State!="unsupported";
    }
    internal static object Run()
    {
        using var root=ProductJournalRootInitializer.Acquire();
        using var audio=new AudioReadOnly();
        var processes=Process.GetProcessesByName("Spotify");
        var identities=new List<SpotifyIdentity>();
        try {
            foreach(var process in processes) {
                try { identities.Add(new SpotifyIdentity(process.Id)); }
                catch(System.ComponentModel.Win32Exception) { }
                catch(InvalidOperationException) { }
                catch(System.Runtime.InteropServices.COMException) { }
            }
            var identity=identities.FirstOrDefault()??throw new RouteBlockedException("SPOTIFY_PROCESS_NOT_FOUND");
            if(identities.Any(item=>!identity.Identity.SameApplication(item.Identity)))throw new RouteBlockedException("SPOTIFY_APPLICATION_AMBIGUOUS");
            using var bound=new Win11SpotifyPolicyResolver(identity.Check).OpenVerified(identity.Identity);
            var endpoints=audio.Endpoints();
            var roles=new[]{RenderRole.Console,RenderRole.Multimedia};
            var before=roles.Select(bound.Get).ToArray();
            var reset=roles.Where(role=>NeedsReset(before[(int)role],endpoints,audio.EndpointForPolicy)).ToArray();
            var file=Path.Combine(root.Binding.PhysicalRoot,"spotify-output-repair-"+Guid.NewGuid()+".jsonl");
            void Record(string phase) { root.Validate();File.AppendAllText(file,JsonSerializer.Serialize(new{phase,at=DateTimeOffset.UtcNow,process=identity.Identity,before,roles=reset})+Environment.NewLine); }
            Record("before");
            foreach(var role in reset) {
                root.Validate();identity.Check(identity.Identity.Pid);
                if(bound.Get(role)!=before[(int)role])throw new RouteBlockedException("SPOTIFY_OUTPUT_CHANGED_DURING_REPAIR");
                bound.Set(role,null);
                if(bound.Get(role) is not null)throw new RouteBlockedException("SPOTIFY_OUTPUT_RESET_UNCONFIRMED");
                Record("role-"+(int)role+"-reset");
            }
            Record("complete");
            return new{repaired=true,changed=reset.Length>0,roles=reset.Select(role=>(int)role).ToArray(),globalDefaultsWritten=false,originalPoliciesRetained=true};
        }
        finally {foreach(var identity in identities)identity.Dispose();foreach(var process in processes)process.Dispose();}
    }
}
