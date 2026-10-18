using System.Runtime.InteropServices;
using System.Text;
using Folia.Capture;
using Folia.RouteResearch;
using Folia.RouteRunner;

internal static class OriginalPolicySafetyTests
{
    internal static int Run()
    {
        var count=0;
        void Require(bool value){if(!value)throw new Exception("Original policy safety assertion failed");}
        void Test(string name,Action action){action();count++;Console.WriteLine("PASS original policy "+name);}
        void Block(string code,Action action){try{action();}catch(RouteBlockedException error)when(error.Message==code){return;}throw new Exception("Expected "+code);}
        const string id="{0.0.0.00000000}.{11111111-1111-1111-1111-111111111111}";
        const string second="{0.0.0.00000000}.{22222222-2222-2222-2222-222222222222}";
        string Policy(string endpoint)=>@"\\?\SWD#MMDEVAPI#"+endpoint+"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
        var raw=Policy(id).ToLowerInvariant();
        EndpointInfo Endpoint(string endpoint)=>new(endpoint,"untrusted name",1,0,1,"",new("unsupported"),Policy(endpoint),48000,2);
        var endpoint=Endpoint(id);var endpoint2=Endpoint(second);
        var target=new BaseRenderEndpoint("base","base-policy","base-owner","base-driver",true,true,true);
        string?[] defaults=[id,id,id,null,null,null];
        string? Map(string value)=>AudioReadOnly.TryMapPolicy(value,out var result)?result:null;
        OriginalEndpointEvidence Safe(EndpointInfo value)=>new(true,"physical:"+value.Id);
        OriginalPolicyBinding[] Verify(string?[] originals,EndpointInfo[]? endpoints=null,Func<EndpointInfo,OriginalEndpointEvidence>? probe=null,OriginalPolicyBinding[]? previous=null)=>
            OriginalPolicySafety.Verify(originals,target,defaults,endpoints??[endpoint,endpoint2],Map,probe??Safe,previous);
        Test("null roles resolve fresh physical defaults",()=>Require(Verify([null,null,"comm"]).All(value=>value.RawPolicy is null)));
        Test("process capture preserves default policies while only DAC is unavailable",()=>
        {
            string?[] originals=[null,null,"comm"];
            var saved=OriginalPolicySafety.Verify(originals,target,["base","base","base",null,null,null],[],Map,
                _=>throw new Exception("No physical output is required for a null policy"),allowDefaultFollow:true);
            OriginalPolicySafety.RequireRetained(saved,originals);
            OriginalPolicySafety.VerifyRestoration(saved,originals,_=>throw new Exception("Null restoration must not pin a DAC"),Safe);
            Require(saved.All(value=>value.RawPolicy is null && value.PhysicalIdentity==""));
        });
        Test("mixed raw explicit and null values are never canonicalized",()=>
        {
            var result=Verify([raw,null,"comm"]);Require(result[0].RawPolicy==raw&&result[0].RawPolicy!=endpoint.PolicyValue&&result[1].RawPolicy is null);
        });
        Test("two distinct safe explicit policies retain both destinations",()=>Require(Verify([raw,Policy(second),"comm"])[1].EndpointId==second));
        Test("unmapped arbitrary policy is rejected",()=>Block("ORIGINAL_POLICY_ENDPOINT_UNRESOLVED",()=>Verify(["arbitrary",null,"comm"])));
        Test("stale mapped endpoint is rejected",()=>Block("ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS",()=>Verify([raw,null,"comm"],[endpoint2])));
        Test("duplicate endpoint identity is rejected",()=>Block("ORIGINAL_ENDPOINT_MISSING_OR_AMBIGUOUS",()=>Verify([raw,null,"comm"],[endpoint,endpoint])));
        Test("unsafe endpoint carries its exact failing condition",()=>
        {
            foreach(var sample in new[]{(endpoint with{State=2},"inactive"),(endpoint with{Flow=1},"not-render"),(endpoint with{PolicyValue=null},"policy-mismatch")})
            {
                try{Verify([raw,null,"comm"],[sample.Item1]);}
                catch(RouteBlockedException error)when(error.Message=="ORIGINAL_ENDPOINT_UNSAFE")
                {Require(error.Diagnostic is {Stage:"endpoint-policy",Role:0,OriginalKind:"explicit"}&&error.Diagnostic.Reason==sample.Item2&&error.Diagnostic.EndpointState==sample.Item1.State);continue;}
                throw new Exception("Missing endpoint diagnostic");
            }
        });
        Test("inactive explicit destination is rejected",()=>Block("ORIGINAL_ENDPOINT_UNSAFE",()=>Verify([raw,null,"comm"],[endpoint with{State=2}])));
        Test("capture destination is not a render original",()=>Block("ORIGINAL_ENDPOINT_UNSAFE",()=>Verify([raw,null,"comm"],[endpoint with{Flow=1}])));
        Test("ambiguous native policy interface is rejected",()=>Block("ORIGINAL_ENDPOINT_UNSAFE",()=>Verify([raw,null,"comm"],[endpoint with{PolicyValue=null}])));
        Test("ordinary Base destination is rejected",()=>Block("ORIGINAL_ENDPOINT_UNSAFE",()=>Verify([raw,null,"comm"],[endpoint with{BaseIdentity=new("verified","base-owner")}])));
        Test("not-Base is insufficient physical evidence",()=>Block("ORIGINAL_PHYSICAL_OWNER_UNPROVEN",()=>Verify([raw,null,"comm"],probe:_=>new(false))));
        Test("owner diagnostic carries exact rejected role and original kind",()=>
        {
            foreach(var original in new string?[]{null,raw})
            {
                try { Verify([original,null,"comm"],probe:_=>new(false,Diagnostic:new("owner-bus-type","wrong-type",Property:"bus-type",PropertyType:3,PropertyLength:16))); }
                catch(RouteBlockedException error) when(error.Message=="ORIGINAL_PHYSICAL_OWNER_UNPROVEN")
                { Require(error.Diagnostic is {Role:0,Stage:"owner-bus-type",Reason:"wrong-type",PropertyType:3,PropertyLength:16}&&error.Diagnostic.OriginalKind==(original is null?"default":"explicit"));continue; }
                throw new Exception("Expected physical rejection diagnostic");
            }
        });
        Test("changed physical owner cannot reuse inspected explicit binding",()=>
        {
            var prior=Verify([raw,null,"comm"]);
            Block("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED",()=>Verify([raw,null,"comm"],probe:_=>new(true,"replaced-physical-owner"),previous:prior));
        });
        Test("exclusive HQ NOTPRESENT state permits same-identity exact compensation",()=>
        {
            var originals=new string?[]{raw,null,"comm"};var prior=Verify(originals);
            OriginalPolicySafety.VerifyRestoration(prior,originals,_=>endpoint with{State=4},Safe);
            Require(prior[0].RawPolicy==raw);
        });
        Test("replacement physical endpoint cannot receive saved explicit policy",()=>
        {
            var originals=new string?[]{raw,null,"comm"};var prior=Verify(originals);
            Block("ORIGINAL_EXPLICIT_ENDPOINT_CHANGED",()=>OriginalPolicySafety.VerifyRestoration(prior,originals,_=>endpoint with{State=4},_=>new(true,"replacement")));
        });
        OriginalEndpointEvidence Probe(DeviceFixture device,TopologyFixture? topology=null)=>PhysicalOriginalEndpointProbe.Read(endpoint,topology??new(){Owner=device.Owner},device);
        Test("synthetic USB media owner uses topology and hardware IDs",()=>Require(Probe(new()).Verified));
        Test("HD-audio physical owner is supported without friendly-name matching",()=>Require(Probe(new(){Owner=@"HDAUDIO\FUNC_01&VEN_10DE&DEV_009F\instance",Hardware=[@"HDAUDIO\FUNC_01&VEN_10DE&DEV_009F&SUBSYS_00000000"],Service="NVHDA"}).Verified));
        Test("A B C and other ROOT virtual owners remain rejected",()=>
        {
            foreach(var hardware in new[]{"VBAudioVACWDM","VBAudioVACWDMA","VBAudioVACWDMB","VBAudioVACWDMC","OtherVirtualAudio"})
                Require(!Probe(new(){Owner=@"ROOT\MEDIA\0001",Hardware=[hardware],Service="virtual"}).Verified);
        });
        Test("unknown hardware bus is not silently declared physical",()=>Require(!Probe(new(){Owner=@"SWD\VirtualAudio\one",Hardware=[@"SWD\VirtualAudio"]}).Verified));
        Test("mismatched hardware-owner identities are rejected",()=>Require(!Probe(new(){Hardware=[@"USB\VID_9999&PID_9999"]}).Verified));
        Test("stopped physical owner is rejected",()=>Require(!Probe(new(){Started=false}).Verified));
        Test("same stopped physical owner can be identified for paused restoration",()=>Require(
            PhysicalOriginalEndpointProbe.Read(endpoint,new TopologyFixture(),new DeviceFixture{Started=false},requireStarted:false).Verified));
        Test("stale topology-to-device-node identity is rejected",()=>Require(!Probe(new(),new(){Owner=@"USB\VID_9999&PID_9999\different"}).Verified));
        Test("ambiguous endpoint topology is rejected",()=>Require(!Probe(new(),new(){Connectors=2}).Verified));
        Test("topology release failure cannot retain positive physical evidence",()=>Require(!Probe(new(),new(){ReleaseFails=true}).Verified));
        return count;
    }
    private sealed class DeviceFixture:IPhysicalOriginalDeviceApi
    {
        internal string Owner=@"USB\VID_20B1&PID_30A0\SyntheticSerial",Service="usbaudio2";
        internal string[] Hardware=[@"USB\VID_20B1&PID_30A0&REV_0100",@"USB\VID_20B1&PID_30A0"];
        internal bool Started=true;
        public (uint Result,uint Node) Locate(string value)=>(0,1);
        public (uint Result,uint Node) Parent(uint value)=>Owner.StartsWith("HDAUDIO",StringComparison.Ordinal)?(0u,2u):(1u,0u);
        public (uint Result,string InstanceId) DeviceId(uint value)=>(0,value==2?@"PCI\VEN_8086&DEV_1234\controller":Owner);
        public (uint Result,uint Status) Status(uint value)=>(0,Started?8u:0u);
        public (uint Result,uint Type,byte[] Bytes,uint Length) DeviceProperty(uint value,uint property)
        {
            var enumerator=value==2?"PCI":Owner.Split('\\')[0];
            if(property==21) {var bus=enumerator=="USB"?new Guid("9d7debbc-c85d-11d1-9eb4-006008c3a19a"):
                enumerator=="PCI"?new Guid("c8ebdfb0-b510-11d0-80e5-00a0c92542e3"):new Guid("11111111-1111-1111-1111-111111111111");return(0,13,bus.ToByteArray(),16);}
            if(property!=24)throw new Exception("Unexpected native property");
            var textBytes=Encoding.Unicode.GetBytes(enumerator+"\0");return(0,18,textBytes,(uint)textBytes.Length);
        }
        public (uint Result,uint Type,byte[] Bytes,uint Length) Property(uint value,uint property)
        {
            var multi=property==2;
            var text=property==9?new Guid("4d36e96c-e325-11ce-bfc1-08002be10318").ToString("B"):
                multi?(value==2?@"PCI\VEN_8086&DEV_1234":string.Join('\0',Hardware)):Service;
            var bytes=Encoding.Unicode.GetBytes(text+(multi?"\0\0":"\0"));return(0,multi?7u:1u,bytes,(uint)bytes.Length);
        }
    }
    private sealed class TopologyFixture:IEndpointTopologyApi
    {
        internal uint Connectors=1;internal bool ReleaseFails;
        internal string Owner=@"USB\VID_20B1&PID_30A0\SyntheticSerial";
        public (int Result,IntPtr Handle) Enumerator()=>(0,new(1));
        public (int Result,IntPtr Handle) Device(IntPtr p,string id)=>(0,new(2));
        public (int Result,IntPtr Handle) Topology(IntPtr p)=>(0,new(3));
        public (int Result,uint Count) ConnectorCount(IntPtr p)=>(0,Connectors);
        public (int Result,IntPtr Handle) Connector(IntPtr p)=>(0,new(4));
        public (int Result,bool Connected) Connected(IntPtr p)=>(0,true);
        public (int Result,string Id) ConnectedDeviceId(IntPtr p)=>(0,"actual-adapter");
        public (int Result,IntPtr Handle) Properties(IntPtr p)=>(0,new(5));
        public (int Result,string Id) InstanceId(IntPtr p)=>(0,Owner);
        public void Release(IntPtr p){if(ReleaseFails)throw new COMException("read-only release failure");}
    }
}
