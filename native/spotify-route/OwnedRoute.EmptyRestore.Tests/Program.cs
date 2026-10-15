using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;
using Folia.RouteRunner;
using Folia.RouteObservation;

if (args.Contains("--stdio", StringComparer.Ordinal)) { StdioBridge.Run(); return; }

// Pure model execution, no Windows assembly/native policy adapter referenced.
// The 24-hour scenario advances an explicit virtual monotonic clock only.
var total=0;
void Check(bool value,string message) { if(!value)throw new Exception(message); }
void Run(string name,Action run) { run();total++;Console.WriteLine("PASS "+name); }
void Ok(ServiceReply r) => Check(r.Ok, r.Code+" / "+r.State);
Run("prepared without any capture can suspend and resume without policy rewrites",()=>{
 using var f=new Fixture();f.Prepare();var writes=f.Writes;
 Ok(f.Send("suspendPaused",new {intervalEpoch=1}));
 Check(f.Service.HasLease&&f.Suspended&&f.IntervalId is null,"Lost prepared owner");
 Ok(f.Send("resumePreparation",new {intervalEpoch=2,selectedSourceUri=Fixture.Track}));
 Ok(f.Send("completePreparedSelection"));f.Start(1);
 Check(f.Writes==writes&&f.Send("status").Ready,"Resume reapplied policy or did not become active");
});
Run("24 virtual hours held pause keeps owner with 4s control heartbeat and zero sampling",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();
 var reads=f.SourceReads;var scans=f.SessionScans;var policy=f.PolicyScans;var writes=f.Writes;var revision=f.Latest!.Revision;
 for(var n=0;n<21600;n++){f.Advance(TimeSpan.FromSeconds(4));var h=f.Send("heartbeat");Ok(h);Check(h.State=="pausedHeld"&&!h.Ready&&!h.IntervalArmed,"Paused heartbeat published permission");Check(f.Service.CheckDeadline() is null,"Control heartbeat expired");}
 Check(f.SourceReads==reads&&f.SessionScans==scans&&f.Writes==writes&&f.PolicyScans==policy&&f.Latest.Revision==revision,"Paused heartbeat sampled/wrote/journaled audio state");
 Check(f.Service.HasLease&&!f.Service.Closed&&f.Elapsed==TimeSpan.FromDays(1),"Virtual long pause expired");
 Console.WriteLine("EVIDENCE virtual elapsed=24h; heartbeats=21600; elapsed wall time is not 24h");
});
Run("resume retires interval identity and rejects stale capture generation",()=>{
 using var f=new Fixture();f.Prepare();f.Start(7);var previous=f.IntervalId;f.Pause();
 var held=f.Send("resumePreparation",new {intervalEpoch=2,selectedSourceUri=Fixture.Track});Ok(held);Check(held.IntervalEpoch==2,"Epoch not advanced");
 Ok(f.Send("completePreparedSelection"));var old=f.Arm(7);Check(!old.Ok&&f.IntervalId is null,"Stale capture proof rearmed");
 f.Start(8);Check(f.IntervalId!=previous&&f.Send("status").Ready,"Old interval reused");
});
Run("wrong track, owner, epoch and late acknowledgement cannot resume retained owner",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();var writes=f.Writes;
 Check(!f.Send("resumePreparation",new {intervalEpoch=2,selectedSourceUri=Fixture.Other}).Ok,"Different selection adopted");
 Check(!f.Send("resumePreparation",new {intervalEpoch=1,selectedSourceUri=Fixture.Track}).Ok,"Old epoch adopted");
 Check(!f.Send("resumePreparation",new {intervalEpoch=2,selectedSourceUri=Fixture.Track,generation=99}).Ok,"Wrong route generation adopted");
 Check(!f.Send("sourceControlResult",new {ok=true}).Ok,"Late source result became an operation");
 Check(f.Suspended&&f.Writes==writes&&!f.Send("heartbeat").Ready,"Rejected caller affected route");
});
Run("unsettled PCM stop and still playing source cannot establish held pause",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Paused=true;f.PcmStopped=false;
 var first=f.Send("suspendPaused",new {intervalEpoch=1});Check(!first.Ok&&first.Code=="PCM_STOP_NOT_CONFIRMED"&&!f.Suspended,"Unchecked capture accepted");
 f.PcmStopped=true;f.Paused=false;var second=f.Send("suspendPaused",new {intervalEpoch=1});Check(!second.Ok&&second.Code=="SOURCE_NOT_PAUSED"&&!f.Suspended,"Playing source accepted");
});
Run("main heartbeat loss at 15s still restores paused exact roles",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();f.Advance(TimeSpan.FromMilliseconds(14999));Check(f.Service.CheckDeadline() is null,"Expired before deadline");f.Advance(TimeSpan.FromMilliseconds(1));
 var r=f.Service.CheckDeadline();Check(r is {Ok:true,State:"closed",ExactOriginalRolesRestored:true},"15s main loss did not restore");f.CheckOriginals();
});
Run("disconnect death restores exact null and explicit original roles before replacement",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();var r=f.Service.Disconnect("OWNER_EOF");Ok(r);f.CheckOriginals();Check(f.Service.Closed&&!f.Service.HasLease,"Dead owner retained falsely");
});
Run("failed restoration retains barrier and forbids new owner",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();f.FailRestore=true;
 var r=f.Send("release");Check(!r.Ok&&r.State=="recoveryRequired"&&f.Service.HasLease,"Failed restore discarded owner");
 var newOwner=f.Acquire();Check(!newOwner.Ok&&newOwner.Code=="LEASE_ALREADY_OWNED","Failed restore allowed newowner");
});
Run("prewrite stop proof failure is retryable only before native restore writes",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Paused=true;f.PcmStopped=false;
 var writes=f.Writes;var first=f.Send("release");Check(!first.Ok&&first.CleanupRetryable&&first.RestoreWritesStarted==false&&f.Writes==writes,"Prewrite recovery receipt lost");
 f.PcmStopped=true;f.ResetReceipt();var next=f.Send("release");Ok(next);f.CheckOriginals();
});
Run("changed paused track restores with actual URI; changed playing track never paused",()=>{
 using(var f=new Fixture()){f.Prepare();f.Start(1);f.Pause();f.TrackUri=Fixture.Other;f.ResetReceipt();Ok(f.Send("release"));f.CheckOriginals();Check(f.PauseCommands==0,"Restore sent source pause");}
 using(var f=new Fixture()){f.Prepare();f.Start(1);f.PcmStopped=true;f.TrackUri=Fixture.Other;f.ResetReceipt();var r=f.Send("release");Check(!r.Ok&&f.Service.HasLease&&f.PauseCommands==0,"Changed playing source was adopted/paused");}
});
Run("transient paused-session failures can retry the exact prewrite restoration",()=>{
 foreach(var code in new[]{"PAUSED_SOURCE_COMPLETE_SESSION_PROOF_REQUIRED","PAUSED_SOURCE_SCAN_INCOMPLETE","PAUSED_SOURCE_SESSIONS_STILL_ACTIVE"}){
  using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();var writes=f.Writes;f.PausedProofFailure=code;
  var first=f.Send("release");Check(!first.Ok&&first.Code==code&&first.CleanupRetryable&&first.RestoreWritesStarted==false&&f.Writes==writes,"Retryable pause cause/owner lost: "+code);
  f.PausedProofFailure=null;Ok(f.Send("release"));f.CheckOriginals();
 }
});
Run("same-receipt before and after native scan rejects a source mutation",()=>{
 using var f=new Fixture();f.Prepare();f.Start(1);f.Pause();f.ChangeDuringScan=true;
 var r=f.Send("resumePreparation",new {intervalEpoch=2,selectedSourceUri=Fixture.Track});Check(!r.Ok&&!r.Ready,"Changed source receipt passed scan fence");
});
Run("old preparation receipt cannot survive resume; monotonic observation and mutation floor retained",()=>{
 var ledger=new PreparationObservationLedger();var now=Fixture.StartTime;
 var target=new OwnedPlaybackTarget("device",Fixture.Track,Fixture.Identity,RequirePreparationObservation:true,PreparationPhase:"selected");
 var prior=new PlaybackStatus("device",Fixture.Track,false,now,true,true,false,8,5,"selected",0);
 ledger.Validate(target,prior,now);ledger.BeginResumePreparation();
 var baseline=target with{PreparationPhase="baseline"};
 foreach(var bad in new[]{prior with{PreparationPhase="baseline"},prior with{PreparationPhase="baseline",ObservationGeneration=9}}){try{ledger.Validate(baseline,bad,now);throw new Exception("Replayed observation accepted");}catch(RouteBlockedException e){Check(e.Message=="PREPARATION_OBSERVATION_REPLAYED","Wrong rejection");}}
 ledger.Validate(baseline,prior with{PreparationPhase="baseline",ObservationGeneration=9,MutationEpoch=6},now);
});
Run("5-second observation receipt age bound remains; indefinite pause is not cached proof",()=>{
 var ledger=new PreparationObservationLedger();var t=new OwnedPlaybackTarget("device",Fixture.Track,Fixture.Identity,RequirePreparationObservation:true,PreparationPhase:"baseline");
 var r=new PlaybackStatus("device",Fixture.Track,false,Fixture.StartTime,true,true,false,1,0,"baseline",0);
 try{ledger.Validate(t,r,Fixture.StartTime.AddSeconds(6));throw new Exception("Expired observation accepted");}catch(RouteBlockedException e){Check(e.Message=="PREPARATION_OBSERVATION_INVALID","Unexpected expiry code");}
});
Console.WriteLine($"PASS {total} pure C# held-pause cases (mock policy only)");

sealed class Fixture : IProductRouteBackend,IProductRouteLifetime,IVerifiedSpotifyResolver,IBoundSpotifyPolicy,ISelectedEndpointVerifier,ISessionObserver,IDurableRouteJournal,ISourcePlaybackControl,IDisposable
{
 public const string Track="spotify:track:AAAAAAAAAAAAAAAAAAAAAA",Other="spotify:track:BBBBBBBBBBBBBBBBBBBBBB";
 public static readonly DateTimeOffset StartTime=new(2026,10,10,0,0,0,TimeSpan.Zero);
 public static readonly SpotifyProcess Identity=new(12,StartTime.Ticks,"sid","policy","image","desktop");
 SpotifyProcess IBoundSpotifyPolicy.Identity=>Identity;
 public ProductRouteService Service {get;}
 public TimeSpan Elapsed;
 public bool RealTime;
 public string? PausedProofFailure;
 readonly long realtimeStart=System.Diagnostics.Stopwatch.GetTimestamp();
 public TimeSpan Monotonic=>RealTime?System.Diagnostics.Stopwatch.GetElapsedTime(realtimeStart):Elapsed;
 public DateTimeOffset Now=>RealTime?DateTimeOffset.UtcNow:StartTime+Elapsed;
 public Func<OwnedPlaybackTarget,PlaybackStatus>? Broker;
 public string? BoundSession; public int BoundGeneration;
 public RouteSelection CurrentSelection=new("capture","render");
 public bool FailColdInspectionOnce;
 public string? RestoreBoundaryFault;
 private int restoreSetterAttempts;
 public bool Paused=true,PcmStopped=true,Suspended,FailRestore,ChangeDuringScan;
 public string TrackUri=Track;
 public int SourceReads,SessionScans,Writes,PauseCommands,PolicyScans;
 public readonly string?[] Originals=[null,"raw-original-endpoint",null];
 readonly string?[] values=[null,"raw-original-endpoint",null];
 public RouteRecord? Latest;
 PreparationObservationLedger ledger=new();
 OwnedPlaybackTarget? readingTarget;
 PlaybackStatus? receipt;
 string? receiptScope;
 long observations,epoch;
 string? leaseId;
 public Fixture(){Service=new(this,()=>Now,()=>Monotonic);}
 public ProductCapabilities Capabilities {get;}=new(true,true,true,true,true,[],IntervalIsolation:true,OwnedSilentRenderLease:true,PreparedSelection:true,BoundedPreparationObservation:true,BoundedRestoreObservation:true,IndefiniteHeldPause:true,FreshResumeInterval:true);
 public ServiceReply Send(string command,object? extra=null){var payload=new Dictionary<string,object?>{{"session","session"},{"generation",1},{"leaseId",leaseId}};if(extra!=null)foreach(var p in JsonSerializer.SerializeToElement(extra).EnumerateObject())payload[p.Name]=p.Value.Clone();return Service.Dispatch(JsonSerializer.Serialize(new{id=Guid.NewGuid().ToString(),command,payload}));}
 public ServiceReply Acquire()=>Send("acquire",new{sourcePaused=true,sourceDeviceId="device",expectedSourceUri=Track,captureDeviceId="capture",renderDeviceId="render",expectedSpotifyProcessId=12,expectedSpotifyStartTimeUtcTicks=Identity.StartTimeUtcTicks.ToString()});
 void Must(ServiceReply r){if(!r.Ok)throw new Exception("Setup failed "+r.Code);}
 public void Prepare(){var r=Acquire();Must(r);leaseId=JsonSerializer.SerializeToElement(r.Lease).GetProperty("leaseId").GetString();Must(Send("authorizePreparedSelection",new{selectedSourceUri=Track}));Must(Send("completePreparedSelection"));}
 public ServiceReply Arm(long generation)=>Send("armCaptureInterval",new{ownedSilentRenderLease=new{captureSession="session",captureGeneration=generation,endpointId="render",sessionInstanceId="keeper"+generation,groupingId="26377ba7-2d95-407a-b2b7-7131377305c2",processId=20,startedAtUtcTicks="639271242001234567"}});
 public void Start(long generation){Must(Arm(generation));Must(Send("authorizeResume",new{selectedSourceUri=Track,captureStarted=true,monitorGainZero=true}));Paused=false;PcmStopped=false;ResetReceipt();Must(Send("status"));}
 public void Pause(){Paused=true;PcmStopped=true;ResetReceipt();Must(Send("suspendPaused",new{intervalEpoch=ServiceIntervalEpoch}));}
 public int ServiceIntervalEpoch=>Send("heartbeat").IntervalEpoch;
 public void Advance(TimeSpan by)=>Elapsed+=by;
 public void ResetReceipt(){receipt=null;receiptScope=null;epoch++;}
 public void CheckOriginals(){if(!values.SequenceEqual(Originals))throw new Exception("Original roles not exactly restored");}
 public ProductDiscovery Inspect(RouteSelection s){ if(FailColdInspectionOnce){FailColdInspectionOnce=false;throw new RouteBlockedException("EXACT_SPOTIFY_AUDIO_PROCESS_UNPROVEN");} CurrentSelection=s;return new(Identity,new(s.RenderDeviceId,"base","pnp","driver",true,true,true),s,Originals.ToArray(),Paused,false,true,true,true,true); }
 public void BindLease(string session,int generation,string lease){BoundSession=session;BoundGeneration=generation;}
 public IProductRouteLifetime Open(ProductDiscovery d){ledger=new();receipt=null;receiptScope=null;readingTarget=null;IntervalGeneration=0;IntervalId=null;Suspended=false;Latest=null;return this;}
 public IVerifiedSpotifyResolver Resolver=>new WindowsProductBackend.GuardedResolver(this, BeforeSetter, () => {}, ImmediatelyBeforeSetter);public ISelectedEndpointVerifier EndpointVerifier=>this;public ISessionObserver Observer=>this;public IDurableRouteJournal Journal=>this;
 public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected){if(expected!=Identity)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");return this;}
 public SpotifyProcess CheckLiveIdentity()=>Identity;public string? Get(RenderRole role)=>values[(int)role];
 public void Set(RenderRole role,string? value){if(FailRestore&&value!="base")throw new RouteBlockedException("RESTORE_READBACK_MISMATCH");if(role==RenderRole.Communications)throw new Exception("Communications setter");values[(int)role]=value;Writes++;}
 public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint e)=>e;
 public SessionObservation Observe(IBoundSpotifyPolicy process,TimeSpan budget){SessionScans++;if(ChangeDuringScan){ResetReceipt();}return new(true,Identity,Now,[new(Identity,"spotify",CurrentSelection.RenderDeviceId,!Paused)]);}
 public RouteRecord? ReadLatest()=>Latest;public void Append(RouteRecord r)=>Latest=r;
 public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord r)=>new(r.TransactionId,Identity,new string('a',64),1,"file",true,true,true);
 public void ValidateOwnership(PreparedRetention r){if(r.Process!=Identity||r.TransactionId!=Latest?.TransactionId)throw new JournalUnavailableException("BAD_RETAINED_OWNER");}
 public void ValidateApplyAuthority(){PolicyScans++;}
 public void ValidatePausedOwnerLiveness(){}
 private ProductSessionObserver? nativeObserver;
 private EmptyFeed? nativeFeed;
 private bool emptyProof;
 public void VerifyPausedSource(OwnedPlaybackTarget target){
  if(PausedProofFailure is not null)throw new RouteBlockedException(PausedProofFailure);
  readingTarget=target;
  nativeFeed??=new EmptyFeed(this);
  nativeObserver??=new ProductSessionObserver(nativeFeed,CurrentSelection.RenderDeviceId,timeProvider:new FixtureClock(this));
  var result=new SourcePauseVerifier(this,target.AllowEmptyPlayerForRestore?nativeObserver.ForEmptyRestore:this,this,()=>Now,ledger).RequirePaused(target);
  emptyProof=result.EmptyPlayer;
 }
 private void BeforeSetter(RenderRole role,string? value){
  if(value=="base")return;
  if(readingTarget is null)throw new Exception("Missing restore target");
  restoreSetterAttempts++;
  if(RestoreBoundaryFault=="active-before-second"&&restoreSetterAttempts==2)Paused=false;
  VerifyPausedSource(readingTarget);
  if(RestoreBoundaryFault=="policy-after-proof")values[(int)role]="external-policy";
  if(RestoreBoundaryFault=="notification-after-proof")nativeFeed!.Changed();
 }
 private void ImmediatelyBeforeSetter(IBoundSpotifyPolicy bound,RenderRole role,string? value){
  if(!emptyProof)return;
  if(value!=Originals[(int)role]||bound.CheckLiveIdentity()!=Identity||bound.Get(role)!="base")throw new RouteBlockedException("EXTERNAL_POLICY_CONFLICT");
  nativeObserver!.RequireCurrentRestoreQuiescence();
 }
 private sealed class FixtureClock(Fixture owner):TimeProvider { public override DateTimeOffset GetUtcNow()=>owner.Now; }
 private sealed class EmptyFeed(Fixture owner):IReadOnlySessionFeed{
  private Action<SessionFeedEvent>? changed;
  public void Changed()=>changed?.Invoke(new(SessionFeedEventKind.SessionChanged,owner.CurrentSelection.RenderDeviceId,"new-session"));
  public bool IsPublicationQuiescent=>true;
  public bool IsStopped=>false;
  public IDisposable RegisterEndpointNotifications(Action<SessionFeedEvent> callback,CancellationToken token){changed=callback;return new Registration();}
  public string[] EnumerateActiveRenderEndpoints(CancellationToken token)=>[owner.CurrentSelection.RenderDeviceId,"physical"];
  public IEndpointSessionFeed OpenEndpoint(string id,Action<SessionFeedEvent> changed,CancellationToken token)=>new Endpoint(owner,id);
  public void Dispose(){}
  private sealed class Registration:IDisposable{public void Dispose(){}}
  private sealed class Endpoint(Fixture owner,string id):IEndpointSessionFeed{
   public string EndpointId=>id;
   public RawAudioSession[] ReadSessions(CancellationToken token)=>id==owner.CurrentSelection.RenderDeviceId
    ?[new("spotify",id,owner.Paused?AudioSessionState.Inactive:AudioSessionState.Active,(uint)Identity.Pid,0,1)]:[];
   public void Dispose(){}
  }
 }
 public void VerifyRestoredTerminal(RouteRecord r,PreparedRetention p)=>CheckOriginals();
 public ProductDefaultStatus ReadDefaultStatus()=>new(true,["physical","physical","physical"],["physical","physical","physical"]);
 public bool IntervalIsolated=>IntervalGeneration!=0&&!Suspended;public int IntervalGeneration{get;private set;}public string? IntervalId{get;private set;}
 public void BindOwnedSilentRenderLease(OwnedSilentRenderLeaseProof p){}
 public void ArmCaptureInterval(string s,int g){IntervalGeneration=g;IntervalId=Guid.NewGuid().ToString();}
 public void SuspendCaptureInterval(){Suspended=true;IntervalGeneration=0;IntervalId=null;}
 public void BeginResumePreparation(){Suspended=false;ledger.BeginResumePreparation();ResetReceipt();}
 public PlaybackStatus ReadFresh(TimeSpan budget){SourceReads++;var t=readingTarget!;if(Broker is not null)return Broker(t);if(t.RequirePreparationObservation||t.RestoreOperationId!=null){var scope=t.RestoreOperationId??t.PreparationPhase;if(scope!=receiptScope){ResetReceipt();receiptScope=scope;}return receipt??=new("device",TrackUri,!Paused,Now,PcmStopped,true,false,++observations,epoch,t.PreparationPhase,0,t.RestoreOperationId);}return new("device",TrackUri,!Paused,Now,PcmStopped,t.RequirePreparedSelection,false);}
 public void PauseExactDevice(string id,TimeSpan budget){PauseCommands++;Paused=true;ResetReceipt();}
 public void Dispose(){} // Owned policy handles are test-only borrowed objects; explicit Service below performs lifecycle disposal.
}
