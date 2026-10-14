using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Folia.RouteRunner;
using Folia.RouteResearch;
using Folia.ProductRoute;
using Microsoft.Win32.SafeHandles;

var count=0;
void Check(bool value,string message){if(!value)throw new Exception(message);}
async Task Test(string name,Func<Task> body){await body();count++;Console.WriteLine("PASS "+name);}
ProductWorkerStart Start()=>new(new string('A',64),new string('B',64),1,2,"test-parent","S-test",Path.Combine(Path.GetTempPath(),"test.jsonl"),new(Path.GetTempPath(),Path.GetTempPath(),null,"S-test"));
ProductPipeFrame Frame(string kind,string? id=null,string? body=null,string? hash=null)=>new(kind,new string('A',64),new string('B',64),id,body,hash);
async Task Acquire(ProductWorkerChannel channel,Feed input)
{
    input.Send(Frame("command","1","{\"id\":\"1\",\"command\":\"acquire\",\"payload\":{\"session\":\"lease\",\"generation\":3}}"));
    await channel.Commands.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));
}
OwnedPlaybackTarget Target()=>new("official","spotify:track:one",new(7,8,"S-test","policy","image","desktop"));
await Test("private pipe queues authenticated commands and replies",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    input.Send(Frame("command","1","{\"id\":\"public\",\"command\":\"hello\",\"payload\":{}}"));
    var command=await channel.Commands.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2));Check(command.Id=="1","Command lost");
    channel.Reply(command.Id,new("public",true,"idle","CAPABILITIES"));var frame=await output.Read();
    Check(frame.Kind=="reply"&&frame.RequestId=="1"&&frame.Nonce==Start().Nonce,"Reply binding lost");
});
await Test("physical-owner diagnostic survives the authenticated worker reply envelope",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    var diagnostic=new PhysicalOwnerDiagnostic("owner-parent","api-failed",0,"default",2,13,Property:"device-id",Bus:"unknown");
    channel.Reply("physical-owner",new("public",false,"blocked","ORIGINAL_PHYSICAL_OWNER_UNPROVEN",PhysicalOwnerDiagnostic:diagnostic));
    var frame=await output.Read();var reply=JsonSerializer.Deserialize<ServiceReply>(frame.Body!,WireJson.Options)!;
    Check(frame.Kind=="reply"&&frame.RequestId=="physical-owner"&&frame.Nonce==Start().Nonce&&frame.RunId==Start().RunId,"Diagnostic reply binding lost");
    Check(!reply.Ok&&reply.Code=="ORIGINAL_PHYSICAL_OWNER_UNPROVEN"&&reply.PhysicalOwnerDiagnostic==diagnostic,"Diagnostic was lost in worker envelope");
});
await Test("wrong nonce closes command stream and withdraws authority",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    input.Send(Frame("command","1","{}") with{Nonce=new string('C',64)});
    Check(!await channel.Commands.WaitToReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2))&&channel.ApplyAuthorityLost,"Wrong nonce accepted");
});
await Test("EOF cannot fabricate restored authority",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    input.End();Check(!await channel.Commands.WaitToReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2))&&channel.ApplyAuthorityLost,"EOF retained authority");
});
await Test("source replies bypass commands and retain exact scope",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    await Acquire(channel,input);var task=Task.Run(()=>channel.CreateSourceControl(Target()).ReadFresh(TimeSpan.FromSeconds(2)));
    var sent=await output.Read();Check(sent.Kind=="source"&&sent.Source?.Session=="lease"&&sent.Source.Generation==3&&sent.Source.Target==Target(),"Source scope lost");
    var status=new PlaybackStatus("official","spotify:track:one",false,DateTimeOffset.UtcNow);
    input.Send(Frame("source-reply",sent.RequestId,JsonSerializer.Serialize(status)));
    Check(await task.WaitAsync(TimeSpan.FromSeconds(2))==status,"Source result lost");
});
await Test("wrong source reply ID cannot prove pause",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    await Acquire(channel,input);var task=Task.Run(()=>channel.CreateSourceControl(Target()).ReadFresh(TimeSpan.FromSeconds(2)));
    await output.Read();input.Send(Frame("source-reply","wrong","{}"));
    try{await task.WaitAsync(TimeSpan.FromSeconds(2));throw new Exception("Wrong ID accepted");}catch(Exception e)when(e is InvalidDataException or AggregateException or JournalUnavailableException or RouteBlockedException){}
    Check(channel.ApplyAuthorityLost,"Wrong source correlation preserved authority");
});
await Test("unsolicited Prepared ACK grants no journal authority",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    input.Send(Frame("prepared-ack",hash:new string('C',64)));
    Check(!await channel.Commands.WaitToReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2))&&channel.ApplyAuthorityLost,"Unsolicited ACK accepted");
});
await Test("cancel closes new-command authority while safe cleanup remains duplex",async()=>
{
    using var input=new Feed();using var output=new Capture();using var channel=new ProductWorkerChannel(Start(),input,output,()=>{});
    await Acquire(channel,input);input.Send(Frame("cancel"));
    Check(!await channel.Commands.WaitToReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2))&&channel.ApplyAuthorityLost,"Cancel did not wake idle worker");
    var task=Task.Run(()=>channel.CreateSourceControl(Target()).ReadFresh(TimeSpan.FromSeconds(2)));
    var sent=await output.Read();var status=new PlaybackStatus("official","spotify:track:one",false,DateTimeOffset.UtcNow);
    input.Send(Frame("source-reply",sent.RequestId,JsonSerializer.Serialize(status)));
    Check(await task.WaitAsync(TimeSpan.FromSeconds(2))==status,"Cancel broke retained cleanup source proof");
});
await Test("non-Windows supervisor blocks before spawning worker",async()=>
{
    if(OperatingSystem.IsWindows())return;
    try{await ProductProcessSupervisor.Start((_,_)=>throw new Exception("Source touched"),CancellationToken.None);throw new Exception("Native process started");}catch(PlatformNotSupportedException){}
});
await Test("invalid terminal after retained Prepared cannot become no-policy proof",()=>
{
    var start=Start();var root=Path.TrimEndingDirectorySeparator(Path.GetTempPath());var path=Path.Combine(root,Guid.NewGuid().ToString("D")+".jsonl");
    var storage=new JournalStorageBinding(root,root,null,"S-test",null,"12345678:0000000000000001","12345678:0000000000000002",JournalSecurity.Policy,1,new string('C',64),root);
    var process=Target().Process;var target=new BaseRenderEndpoint("base","policy-base","owner","driver",true,true,true);
    var record=new RouteRecord(1,1,Guid.NewGuid(),process,process,target,RouteStage.Prepared,[new(RenderRole.Console,null,RoleStage.Untouched),new(RenderRole.Multimedia,null,RoleStage.Untouched),new(RenderRole.Communications,null,RoleStage.Untouched)],null,DateTimeOffset.UtcNow);
    var receipt=new PreparedJournalReceipt(start.RunId,22,33,"S-test",path,"12345678:0000000000000003",storage,99,new(record,512,new string('D',64)),true);
    var proof=new RunJournalProof(path,storage,start.RunId,process.Pid,process.StartTimeUtcTicks,target.Id);
    using var retained=proof.AcceptPrepared(receipt,22,33,"S-test",_=>new SafeFileHandle(new IntPtr(999),false));
    Check(ProductRetainedJournalOwner.HasAcceptedPrepared(proof),"Prepared authority missing");
    var invalid=new TerminalJournalReceipt(start.RunId,22,33,"S-test",path,receipt.FileIdentity,storage,receipt.Prepared.FrameHash,512,new(record,512,new string('D',64)),[]);
    try {proof.AcceptTerminal(invalid,22,33,"S-test");throw new Exception("Invalid terminal accepted");}catch(JournalUnavailableException){}
    Check(proof.Retained is null&&ProductRetainedJournalOwner.HasAcceptedPrepared(proof),"Invalidation erased possible policy mutation");
    return Task.CompletedTask;
});
count+=await ParentReceiptTests.Run();
count+=await InspectionWorkerLifecycleTests.Run();
count+=await OperationFailureDiagnosticTests.Run();
count+=await PhysicalOwnerDiagnosticTransportTests.Run();
Console.WriteLine($"PASS {count} private transport tests (device-free)");
sealed class Feed:TextReader
{
    private readonly Channel<char> data=Channel.CreateUnbounded<char>();
    public void Send(ProductPipeFrame frame){foreach(var c in JsonSerializer.Serialize(frame)+"\n")data.Writer.TryWrite(c);}
    public void End()=>data.Writer.TryComplete();
    public override async ValueTask<int> ReadAsync(Memory<char> buffer,CancellationToken cancellationToken=default)
    {if(!await data.Reader.WaitToReadAsync(cancellationToken))return 0;if(!data.Reader.TryRead(out var c))return 0;buffer.Span[0]=c;return 1;}
    protected override void Dispose(bool disposing){End();base.Dispose(disposing);}
}
sealed class Capture:TextWriter
{
    private readonly Channel<string> rows=Channel.CreateUnbounded<string>();
    public override Encoding Encoding=>Encoding.UTF8;
    public override void WriteLine(string? value){if(value is not null)rows.Writer.TryWrite(value);}
    public async Task<ProductPipeFrame> Read()=>JsonSerializer.Deserialize<ProductPipeFrame>(await rows.Reader.ReadAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(2)))!;
}
