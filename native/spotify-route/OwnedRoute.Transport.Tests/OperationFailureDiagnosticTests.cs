using System.ComponentModel;
using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteRunner;

// Checks fixed classifications and the public JSON boundary without invoking
// Windows APIs, opening a journal, launching a process or reading private data.
internal static class OperationFailureDiagnosticTests
{
    internal static async Task<int> Run()
    {
        var count=0;
        void Test(string name,Action body){body();count++;Console.WriteLine("PASS "+name);}
        foreach(var (code,cause) in new[]{
            ("PRODUCT_WORKER_START_FAILED","worker-start-failed"),
            ("PRODUCT_SINGLE_FILE_HOST_REQUIRED","worker-image-invalid"),
            ("PRODUCT_CHILD_IMAGE_MISMATCH","worker-identity-unconfirmed"),
            ("PRODUCT_WORKER_UNAVAILABLE","worker-unavailable"),
            ("PRODUCT_WORKER_EOF","worker-eof"),
            ("PRODUCT_WORKER_FRAME_BINDING_MISMATCH","worker-protocol-invalid"),
            ("PRODUCT_STDERR_LIMIT","worker-stderr-limit"),
            ("JOURNAL_KNOWN_FOLDER_UNAVAILABLE","journal-context-unavailable"),
            ("JOURNAL_DIRECTORY_OPEN_UNAVAILABLE","journal-root-unavailable"),
            ("JOURNAL_DIRECTORY_IDENTITY_UNSAFE","journal-root-unsafe"),
            ("JOURNAL_SECURITY_UNSAFE_GRANT","journal-security-rejected")})
            Test("fixed operation cause does not emit native detail: "+cause,()=>
            {
                var value=OperationFailureDiagnosticProjection.FromException("worker-start",new Exception(code+":private-path-or-identity"));
                Require(value==new OperationFailureDiagnostic("worker-start",cause),"Known safe cause lost");
                var wire=JsonSerializer.Serialize(value,WireJson.Options);
                Require(!wire.Contains("private",StringComparison.Ordinal)&&!wire.Contains(code,StringComparison.Ordinal),"Native detail leaked");
            });
        foreach(var (error,cause) in new (Exception,string)[]{
            (new OperationCanceledException("private"),"request-cancelled"),
            (new UnauthorizedAccessException("private"),"access-denied"),
            (new IOException("private"),"io-failed"),
            (new InvalidDataException("private"),"invalid-data"),
            (new JsonException("private"),"json-invalid"),
            (new ObjectDisposedException("private"),"object-disposed"),
            (new PlatformNotSupportedException("private"),"platform-unsupported"),
            (new Win32Exception(5,"private"),"win32-failed"),
            (new Exception("UNKNOWN_PRIVATE_CODE:private"),"unknown")})
            Test("exception type classification stays bounded: "+cause,()=>
                Require(OperationFailureDiagnosticProjection.FromException("inspect-request",error)==new OperationFailureDiagnostic("inspect-request",cause),"Type fallback changed"));
        Test("unknown lookalike code does not become known journal authority",()=>
            Require(OperationFailureDiagnosticProjection.FromException("worker-start",new Exception("JOURNAL_SECURITY_MADE_UP:private"))==new OperationFailureDiagnostic("worker-start","unknown"),"Unknown prefix became known cause"));
        Test("public projection rejects arbitrary stages or causes",()=>
        {
            Require(OperationFailureDiagnosticProjection.Project(new("private-path","worker-eof")) is null,"Unknown stage admitted");
            Require(OperationFailureDiagnosticProjection.Project(new("worker-start","private-path")) is null,"Unknown cause admitted");
            Require(OperationFailureDiagnosticProjection.FromException("private-stage",new IOException("private")) is null,"Unknown originating stage admitted");
        });
        using(var input=new StringReader("{\"id\":\"1\",\"command\":\"inspect\",\"payload\":{}}\n{\"id\":\"2\",\"command\":\"close\",\"payload\":{}}\n"))
        using(var output=new StringWriter())
        {
            var caps=new ProductCapabilities(true,true,true,true,true,[],IntervalIsolation:true);
            await using var runtime=new ProductPublicRuntime(caps,input,output,(_,_)=>throw new IOException("JOURNAL_DIRECTORY_OPEN_UNAVAILABLE:private-path"));
            Require(await runtime.Run()==0,"Factory failure should stay no-write");
            var row=JsonSerializer.Deserialize<JsonElement>(output.ToString().Split('\n',StringSplitOptions.RemoveEmptyEntries)[0]);
            var diagnostic=row.GetProperty("operationFailureDiagnostic");
            Require(row.GetProperty("code").GetString()=="NO_POLICY_WRITES"&&row.GetProperty("failureCode").GetString()=="PRODUCT_OPERATION_FAILED","Existing failure authority changed");
            Require(diagnostic.GetProperty("stage").GetString()=="worker-start"&&diagnostic.GetProperty("cause").GetString()=="journal-root-unavailable","Factory origin was lost");
            Require(diagnostic.EnumerateObject().Count()==2&&!output.ToString().Contains("private",StringComparison.Ordinal),"Factory detail leaked");
            count++;Console.WriteLine("PASS factory failure retains no-write result and exposes only safe stage/cause");
        }
        return count;
    }
    private static void Require(bool condition,string message){if(!condition)throw new Exception(message);}
}
