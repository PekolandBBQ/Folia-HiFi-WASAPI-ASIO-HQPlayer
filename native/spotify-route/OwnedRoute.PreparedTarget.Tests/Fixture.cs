using System.Text.Json;
using Folia.ProductRoute;
using Folia.RouteResearch;

// Device-free fixture derived from the frozen held-pause fixture, with explicit native observations.
sealed class Fixture : IProductRouteBackend,IProductRouteLifetime,IVerifiedSpotifyResolver,IBoundSpotifyPolicy,ISelectedEndpointVerifier,ISessionObserver,IDurableRouteJournal,ISourcePlaybackControl,IDisposable
{
 public const string Track="spotify:track:AAAAAAAAAAAAAAAAAAAAAA",Other="spotify:track:BBBBBBBBBBBBBBBBBBBBBB";
 public static readonly DateTimeOffset StartTime=new(2026,10,10,0,0,0,TimeSpan.Zero);
 public static readonly SpotifyProcess Identity=new(12,StartTime.Ticks,"sid","policy","image","desktop");
 SpotifyProcess IBoundSpotifyPolicy.Identity=>Identity;
 public ProductRouteService Service {get;}
 public TimeSpan Elapsed;
 public int Epoch=1; public Func<SessionObservation,SessionObservation>? AlterObservation; public SpotifyProcess Live=Identity;
 public bool RealTime=false;
 public bool RequiresTargetEndpointActivity {get;set;}=true;
 public Action? OnValidateAuthority;
 readonly long realtimeStart=System.Diagnostics.Stopwatch.GetTimestamp();
 public TimeSpan Monotonic=>RealTime?System.Diagnostics.Stopwatch.GetElapsedTime(realtimeStart):Elapsed;
 public DateTimeOffset Now=>RealTime?DateTimeOffset.UtcNow:StartTime+Elapsed;
 public Func<OwnedPlaybackTarget,PlaybackStatus>? Broker=null;
 public string? BoundSession; public int BoundGeneration;
 public RouteSelection CurrentSelection=new("capture","render");
 public bool FailColdInspectionOnce;
 public bool CaptureChildExited;
 public bool Paused=true,PcmStopped=true,Suspended,FailRestore=false,ChangeDuringScan=false;
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
 public ProductCapabilities Capabilities {get;set;}=new(true,true,true,true,true,[],IntervalIsolation:true,OwnedSilentRenderLease:true,PreparedSelection:true,BoundedPreparationObservation:true,BoundedRestoreObservation:true,IndefiniteHeldPause:true,FreshResumeInterval:true,BoundedPausedHoldObservation:true,PreparedTargetActivity:true);
 public ServiceReply Send(string command,object? extra=null){var payload=new Dictionary<string,object?>{{"session","session"},{"generation",1},{"leaseId",leaseId},{"intervalEpoch",Epoch}};if(extra!=null)foreach(var p in JsonSerializer.SerializeToElement(extra).EnumerateObject())payload[p.Name]=p.Value.Clone();return Service.Dispatch(JsonSerializer.Serialize(new{id=Guid.NewGuid().ToString(),command,payload}));}
 public ServiceReply Acquire()=>Send("acquire",new{sourcePaused=true,sourceDeviceId="device",expectedSourceUri=Track,captureDeviceId="capture",renderDeviceId="render",expectedSpotifyProcessId=12,expectedSpotifyStartTimeUtcTicks=Identity.StartTimeUtcTicks.ToString()});
 void Must(ServiceReply r){if(!r.Ok)throw new Exception("Setup failed "+r.Code);}
 public void BeginPreparation(){var r=Acquire();Must(r);leaseId=JsonSerializer.SerializeToElement(r.Lease).GetProperty("leaseId").GetString();Must(Send("authorizePreparedSelection",new{selectedSourceUri=Track}));}
 public void Prepare(){var r=Acquire();Must(r);leaseId=JsonSerializer.SerializeToElement(r.Lease).GetProperty("leaseId").GetString();Must(Send("authorizePreparedSelection",new{selectedSourceUri=Track}));Paused=false;Must(Send("verifyPreparedTargetActive",new{selectedSourceUri=Track}));Paused=true;ResetReceipt();Must(Send("completePreparedSelection"));}
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
 public IVerifiedSpotifyResolver Resolver=>this;public ISelectedEndpointVerifier EndpointVerifier=>this;public ISessionObserver Observer=>this;public IDurableRouteJournal Journal=>this;
 public IBoundSpotifyPolicy OpenVerified(SpotifyProcess expected){if(expected!=Identity)throw new RouteBlockedException("SPOTIFY_INSTANCE_CHANGED");return this;}
 public SpotifyProcess CheckLiveIdentity()=>Live;public string? Get(RenderRole role)=>values[(int)role];
 public void Set(RenderRole role,string? value){if(FailRestore&&value!="base")throw new RouteBlockedException("RESTORE_READBACK_MISMATCH");if(role==RenderRole.Communications)throw new Exception("Communications setter");values[(int)role]=value;Writes++;}
 public BaseRenderEndpoint VerifySelected(BaseRenderEndpoint e)=>e;
 public SessionObservation Observe(IBoundSpotifyPolicy process,TimeSpan budget){SessionScans++;if(ChangeDuringScan){ResetReceipt();}var observation=new SessionObservation(true,Identity,Now,[new(Identity,"spotify",CurrentSelection.RenderDeviceId,!Paused)]);return AlterObservation?.Invoke(observation)??observation;}
 public RouteRecord? ReadLatest()=>Latest;public void Append(RouteRecord r)=>Latest=r;
 public PreparedRetention RetainAndAcknowledgePrepared(RouteRecord r)=>new(r.TransactionId,Identity,new string('a',64),1,"file",true,true,true);
 public void ValidateOwnership(PreparedRetention r){if(r.Process!=Identity||r.TransactionId!=Latest?.TransactionId)throw new JournalUnavailableException("BAD_RETAINED_OWNER");}
 public void ValidateApplyAuthority(){PolicyScans++;OnValidateAuthority?.Invoke();if(CaptureChildExited)throw new RouteBlockedException("OWNED_SILENT_RENDER_LEASE_LOST");}
 public void ValidatePausedOwnerLiveness(){}
 public void VerifyPausedSource(OwnedPlaybackTarget target){readingTarget=target;new SourcePauseVerifier(this,this,this,()=>Now,ledger,requireNativeQuiescence:RequiresTargetEndpointActivity).RequirePaused(target);}
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
