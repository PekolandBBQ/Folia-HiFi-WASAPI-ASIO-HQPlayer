using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Serialization;
using Folia.Capture;
using Folia.RouteResearch;

namespace Folia.RouteRunner;

internal sealed record EndpointInfo(string Id, string Name, uint State, uint Flow, uint? FormFactor,
    string InstanceId, BaseCableIdentityEvidence BaseIdentity, string? PolicyValue, uint? ConfiguredRate, ushort? ConfiguredChannels);
internal sealed record NativeSession(long ReportedProcessId,string InstanceId,string EndpointId,int State,int ProcessIdHResult=0,
    [property:JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)] int? SystemSoundsHResult=null,
    [property:JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)] string? SystemSoundsDiagnosticError=null)
{
    public bool HasSingleProcessIdentity => ProcessIdHResult==0 && ReportedProcessId is >=0 and <=int.MaxValue;
    public string ProcessIdHResultHex => "0x"+unchecked((uint)ProcessIdHResult).ToString("X8");
    public string ProcessIdentityStatus => ProcessIdHResult switch
    {
        0 when HasSingleProcessIdentity => "single-process-reported",
        SessionIdentity.NoSingleProcess => "AUDCLNT_S_NO_SINGLE_PROCESS",
        <0 => "failed-not-valid",
        _ => "unrecognized-or-unrepresentable-process-identity"
    };
    [JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)]
    public bool? IsSystemSounds => SystemSoundsHResult switch { 0=>true,1=>false,_=>null };
    [JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)]
    public string? SystemSoundsHResultHex => SystemSoundsHResult is int hr?"0x"+unchecked((uint)hr).ToString("X8"):null;
    [JsonIgnore(Condition=JsonIgnoreCondition.WhenWritingNull)]
    public string? SystemSoundsClassification => SystemSoundsHResult is null && SystemSoundsDiagnosticError is null?null:
        IsSystemSounds is true?"system-sounds":IsSystemSounds is false?"not-system-sounds":"unknown";
    public string ProcessIdMeaning => ProcessIdHResult==SessionIdentity.NoSingleProcess
        ? "Initial session-creator PID only; not sole session membership or trusted Spotify ownership"
        : HasSingleProcessIdentity ? "Reported single process; independent application verification still required"
        : "Raw output retained; exact session ownership is unknown";
}
internal static class SessionIdentity
{
    // Microsoft's GetProcessId contract uses AUDCLNT_SUCCESS(0x00d);
    // FACILITY_AUDCLNT=2185 (0x889), severity success -> 0x0889000D.
    internal const int NoSingleProcess=0x0889000D;
    internal static NativeSession Decode(uint reportedPid,int hresult,string instanceId,string endpointId,uint state)
    {
        if(hresult<0) Marshal.ThrowExceptionForHR(hresult); // Fatal API failures remain fatal.
        if(state>2 || string.IsNullOrWhiteSpace(instanceId) || string.IsNullOrWhiteSpace(endpointId))
            throw new InvalidDataException("SESSION_FIELDS_INVALID");
        return new(reportedPid,instanceId,endpointId,(int)state,hresult);
    }
    internal static void RequireUnambiguousForApply(NativeSession[] sessions)
    {
        // Only the same row's exact S_OK from IsSystemSoundsSession can exclude it.
        // Unknown system classification, PID 0 and cross-process rows never qualify.
        if(sessions.Any(x=>x.IsSystemSounds!=true &&
            (x.IsSystemSounds!=false || !x.HasSingleProcessIdentity || x.ReportedProcessId<=0)))
            throw new RouteBlockedException("SESSION_IDENTITY_AMBIGUOUS_APPLY_BLOCKED");
    }
}
// Standard IAudioSessionControl2 slot-15 HRESULT-only getter. Failure remains unknown.
internal static class SystemSoundsDiagnostic
{
    internal static NativeSession Read(NativeSession row,Func<int> getter)
    {
        try { return row with { SystemSoundsHResult=getter() }; }
        catch(Exception e) { return row with { SystemSoundsDiagnosticError=e.GetType().Name+":"+e.Message }; }
    }
}
internal static class ReadOnlyDiagnostics
{
    internal static NativeSession[] Scan(Func<int[]> candidatePids,Func<NativeSession[]> scan)
    {
        Evidence.Emit("SPOTIFY_CANDIDATES",new {candidatePids=candidatePids(),identityVerified=false,
            note="Name-only candidates; no automatic selection or trusted session ownership implied"});
        var sessions=scan();
        Evidence.Emit("READONLY_SESSIONS",new { evidenceKind="enumerator-snapshot",completeForProcess=false,
            notificationTracker=false,ambiguousIdentityRows=sessions.Count(x=>!x.HasSingleProcessIdentity),
            limitation="May omit sessions; ambiguous reported PIDs are not trusted ownership or routing evidence",sessions });
        return sessions;
    }
}

// Standard MMDevice, property-store and session-enumeration getters only. No audio
// client is activated, no stream is initialized, and no global/format setter is bound.
internal sealed class AudioReadOnly : IDisposable, ISelectedEndpointVerifier
{
    [StructLayout(LayoutKind.Sequential)] private struct Key { public Guid Format; public uint Id; }
    [StructLayout(LayoutKind.Explicit, Size=24)] private struct Prop
    { [FieldOffset(0)] public ushort Type; [FieldOffset(8)] public IntPtr Pointer; [FieldOffset(8)] public uint UInt; [FieldOffset(16)] public IntPtr BlobPointer; }
    [DllImport("ole32.dll")] private static extern int CoCreateInstance(in Guid cls, IntPtr outer, uint context, in Guid iid, out IntPtr value);
    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint mode);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref Prop value);
    [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] private static extern uint CM_Get_Device_Interface_List_SizeW(out uint length, in Guid guid, string? deviceId, uint flags);
    [DllImport("cfgmgr32.dll", CharSet=CharSet.Unicode)] private static extern uint CM_Get_Device_Interface_ListW(in Guid guid, string? deviceId, [Out] char[] buffer, uint length, uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int EnumFn(IntPtr self, int flow, uint states, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DefaultFn(IntPtr self, int flow, int role, out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int DeviceFn(IntPtr self,[MarshalAs(UnmanagedType.LPWStr)]string id,out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int UIntFn(IntPtr self,out uint value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int HResultFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PtrFn(IntPtr self,out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ItemFn(IntPtr self,uint index,out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int OpenFn(IntPtr self,uint mode,out IntPtr value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int PropFn(IntPtr self,in Key key,ref Prop value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int ActivateFn(IntPtr self,in Guid iid,uint context,IntPtr parameters,out IntPtr value);
    private static T Method<T>(IntPtr self,int slot) where T:Delegate => self == IntPtr.Zero ? throw new InvalidDataException("NULL_COM_POINTER") : Marshal.GetDelegateForFunctionPointer<T>(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self),slot*IntPtr.Size));
    private static void Check(int hr) { if(hr<0) Marshal.ThrowExceptionForHR(hr); }
    private static void Release(IntPtr p) { if(p!=IntPtr.Zero) Marshal.Release(p); }
    private static readonly Guid Class=new("bcde0395-e52f-467c-8e3d-c4579291692e"), Interface=new("a95664d2-9614-4f35-a746-de8db63617e6");
    private static readonly Guid RenderInterface=new("e6327cad-dcec-4949-ae8a-991e976a79d2"), SessionManager=new("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f"), SessionControl2=new("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d");
    private IntPtr enumerator;
    private readonly string[] interfaces;
    internal AudioReadOnly(bool readInterfaces=true)
    {
        Check(CoInitializeEx(IntPtr.Zero,0));
        try { Check(CoCreateInstance(in Class,IntPtr.Zero,1,in Interface,out enumerator)); interfaces=readInterfaces?ReadInterfaces():[]; }
        catch { Release(enumerator); CoUninitialize(); throw; }
    }
    internal static string ReadString(IntPtr p,int limit=32768)
    {
        if(p==IntPtr.Zero) throw new InvalidDataException("NULL_COM_STRING");
        for(var n=0;n<=limit;n++) if(Marshal.ReadInt16(p,n*2)==0) return Marshal.PtrToStringUni(p,n)!;
        throw new InvalidDataException("COM_STRING_LIMIT");
    }
    private static string OwnedString(IntPtr self,int slot)
    {
        IntPtr p=IntPtr.Zero;
        try { Check(Method<PtrFn>(self,slot)(self,out p)); return ReadString(p); }
        finally { if(p!=IntPtr.Zero) Marshal.FreeCoTaskMem(p); }
    }
    private static object? Property(IntPtr store,string guid,uint id)
    {
        var p=new Prop();
        try
        {
            var key=new Key{Format=new Guid(guid),Id=id};
            Check(Method<PropFn>(store,5)(store,in key,ref p));
            if(p.Type==0) return null;
            if(p.Type==31) return ReadString(p.Pointer);
            if(p.Type==19) return p.UInt;
            if(p.Type==65 && p.UInt is >=18 and <=128 && p.BlobPointer!=IntPtr.Zero)
            { var bytes=new byte[p.UInt]; Marshal.Copy(p.BlobPointer,bytes,0,bytes.Length); return bytes; }
            return null;
        }
        finally { Check(PropVariantClear(ref p)); }
    }
    internal static bool TryMapPolicy(string policy,out string id)
    {
        const string prefix="\\\\?\\SWD#MMDEVAPI#";
        var suffix="#"+RenderInterface.ToString("B");
        id="";
        if(!policy.StartsWith(prefix,StringComparison.OrdinalIgnoreCase)||!policy.EndsWith(suffix,StringComparison.OrdinalIgnoreCase)) return false;
        id=policy[prefix.Length..^suffix.Length];
        return id.Length==55 && id.StartsWith("{0.0.0.00000000}.",StringComparison.OrdinalIgnoreCase) && Guid.TryParse(id[17..],out _);
    }
    private static string[] ReadInterfaces()
    {
        var cr=CM_Get_Device_Interface_List_SizeW(out var length,in RenderInterface,null,0);
        if(cr!=0 || length is <2 or >1_048_576) throw new InvalidDataException("RENDER_INTERFACE_LIST_SIZE_"+cr);
        var buffer=new char[length]; cr=CM_Get_Device_Interface_ListW(in RenderInterface,null,buffer,length,0);
        if(cr!=0 || buffer[^1]!='\0' || buffer[^2]!='\0') throw new InvalidDataException("RENDER_INTERFACE_LIST_"+cr);
        return new string(buffer).Split('\0',StringSplitOptions.RemoveEmptyEntries);
    }
    internal string? PolicyFor(string id)
    {
        var values=interfaces.Where(x=>TryMapPolicy(x,out var endpoint)&&string.Equals(endpoint,id,StringComparison.OrdinalIgnoreCase)).ToArray();
        return values.Length==1?values[0]:null;
    }
    internal string? EndpointForPolicy(string value)
    { return interfaces.Any(x=>string.Equals(x,value,StringComparison.OrdinalIgnoreCase)) && TryMapPolicy(value,out var id)?id:null; }
    private EndpointInfo Describe(IntPtr device, bool identityOnly=false)
    {
        var endpointInterface=new Guid("1be09788-6894-4089-8586-9a2a6c265ac5"); IntPtr endpoint=IntPtr.Zero; uint flow;
        try
        {
            Check(Marshal.QueryInterface(device,ref endpointInterface,out endpoint));
            Check(Method<UIntFn>(endpoint,3)(endpoint,out flow));
            if(flow>1) throw new InvalidDataException("ENDPOINT_FLOW_INVALID");
        }
        finally { Release(endpoint); }
        var id=OwnedString(device,5); Check(Method<UIntFn>(device,6)(device,out var state));
        IntPtr store=IntPtr.Zero;
        try {
        Check(Method<OpenFn>(device,4)(device,0,out store));
        var instance=Property(store,"78c34fc8-104a-4aca-9ea4-524d52996e57",256) as string ?? "";
        var identity=EndpointIdentityProbe.Read(id,instance);
        if(identityOnly) return new(id,"",state,flow,null,instance,identity,null,null,null);
        var name=Property(store,"a45c254e-df1c-4efd-8020-67d146a850e0",14) as string ?? "";
        var form=Property(store,"1da5d803-d492-4edd-8c23-e0c0ffee7f0e",0) as uint?;
        var blob=Property(store,"f19f064d-082c-4e27-bc73-6882a1bb8e4c",0) as byte[];
        return new(id,name,state,flow,form,instance,identity,PolicyFor(id),blob is null?null:BitConverter.ToUInt32(blob,4),blob is null?null:BitConverter.ToUInt16(blob,2));
        } finally { Release(store); }
    }
    internal EndpointInfo Endpoint(string id)
    {
        IntPtr p=IntPtr.Zero;
        try { Check(Method<DeviceFn>(enumerator,5)(enumerator,id,out p)); return Describe(p); }
        finally { Release(p); }
    }
    // Only state/flow/Base identity participate in the default feedback guard.
    internal EndpointInfo EndpointIdentity(string id)
    {
        IntPtr p=IntPtr.Zero;
        try { Check(Method<DeviceFn>(enumerator,5)(enumerator,id,out p)); return Describe(p,true); }
        finally { Release(p); }
    }
    internal EndpointInfo[] Endpoints(int flow=0,uint states=1)
    {
        IntPtr collection=IntPtr.Zero; var result=new List<EndpointInfo>();
        try
        {
            Check(Method<EnumFn>(enumerator,3)(enumerator,flow,states,out collection)); Check(Method<UIntFn>(collection,3)(collection,out var count));
            if(count>128) throw new InvalidDataException("ENDPOINT_LIMIT");
            for(uint i=0;i<count;i++) { IntPtr p=IntPtr.Zero; try { Check(Method<ItemFn>(collection,4)(collection,i,out p)); result.Add(Describe(p)); } finally { Release(p); } }
            return result.ToArray();
        }
        finally { Release(collection); }
    }
    internal string Default(int role)
    {
        IntPtr p=IntPtr.Zero;
        try { Check(Method<DefaultFn>(enumerator,4)(enumerator,0,role,out p)); return OwnedString(p,5); }
        finally { Release(p); }
    }
    // Point-in-time diagnostic snapshot. IAudioSessionEnumerator may omit sessions;
    // callers must not equate this list with a complete retained session inventory.
    internal NativeSession[] Sessions() => Sessions(false);
    internal NativeSession[] Sessions(bool classifySystemSounds)
    {
        IntPtr collection=IntPtr.Zero; var result=new List<NativeSession>();
        try
        {
            Check(Method<EnumFn>(enumerator,3)(enumerator,0,1,out collection)); Check(Method<UIntFn>(collection,3)(collection,out var count));
            if(count>128) throw new InvalidDataException("ENDPOINT_LIMIT");
            for(uint i=0;i<count;i++)
            {
                IntPtr endpoint=IntPtr.Zero,manager=IntPtr.Zero,sessions=IntPtr.Zero;
                try
                {
                    Check(Method<ItemFn>(collection,4)(collection,i,out endpoint)); var id=OwnedString(endpoint,5);
                    Check(Method<ActivateFn>(endpoint,3)(endpoint,in SessionManager,23,IntPtr.Zero,out manager));
                    Check(Method<PtrFn>(manager,5)(manager,out sessions)); Check(Method<UIntFn>(sessions,3)(sessions,out var n));
                    if(n>256) throw new InvalidDataException("SESSION_LIMIT");
                    for(uint j=0;j<n;j++)
                    {
                        IntPtr session=IntPtr.Zero,control=IntPtr.Zero;
                        try
                        {
                            Check(Method<ItemFn>(sessions,4)(sessions,j,out session)); var iid=SessionControl2;
                            Check(Marshal.QueryInterface(session,ref iid,out control));
                            var pidResult=Method<UIntFn>(control,14)(control,out var pid); Check(pidResult);
                            Check(Method<UIntFn>(control,3)(control,out var state));
                            var instance=OwnedString(control,13);
                            var row=SessionIdentity.Decode(pid,pidResult,instance,id,state);
                            if(classifySystemSounds)
                                row=SystemSoundsDiagnostic.Read(row,()=>Method<HResultFn>(control,15)(control));
                            result.Add(row);
                        }
                        finally { Release(control); Release(session); }
                    }
                }
                finally { Release(sessions); Release(manager); Release(endpoint); }
            }
            return result.ToArray();
        }
        finally { Release(collection); }
    }
    internal BaseRenderEndpoint Select(string id) => SelectVerified(id,Endpoints(2));
    internal static BaseRenderEndpoint SelectVerified(string id,EndpointInfo[] endpoints)
    {
        var item=endpoints.Single(x=>string.Equals(x.Id,id,StringComparison.OrdinalIgnoreCase));
        var sameOwner=endpoints.Where(x=>x.State==1 && BaseCableIdentity.SameOwner(x.BaseIdentity,item.BaseIdentity)).ToArray();
        if(item.State!=1 || item.Flow!=0 || item.BaseIdentity.State!="verified" || item.FormFactor!=1 || item.PolicyValue==null ||
            sameOwner.Count(x=>x.Flow==0 && x.FormFactor==1)!=1 || sameOwner.Count(x=>x.Flow==1)!=1) throw new RouteBlockedException("ORDINARY_BASE_SPEAKER_IDENTITY_UNPROVED");
        return new(item.Id,item.PolicyValue,item.BaseIdentity.OwnerInstanceId!,BaseCableIdentity.HardwareId+"|"+BaseCableIdentity.Service+"|"+BaseCableIdentity.MediaClass,true,true,true);
    }
    public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint expected) => Select(expected.Id);
    public void Dispose() { Release(enumerator); enumerator=IntPtr.Zero; CoUninitialize(); }
}
