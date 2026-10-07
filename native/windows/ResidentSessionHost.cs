// One bounded interactive-session process; perception has no input port.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using WowJev.Input;

static class ResidentSessionHost
{
    static string Stage="host_options";
    static Dictionary<string,object> Failure(Exception error){var win=error as System.ComponentModel.Win32Exception;var inner=error.InnerException as System.ComponentModel.Win32Exception;return ResidentWire.Obj("reason",error is InvalidOperationException?error.Message:"resident_host_failed:"+error.GetType().Name,"stage",Stage,"exception_type",error.GetType().FullName,"message",error.Message,"hresult",error.HResult,"win32_native_error",win!=null?(object)win.NativeErrorCode:inner!=null?(object)inner.NativeErrorCode:null,"stack",error.StackTrace,"at_windows_qpc_ms",Clock.PreciseMs);}
    sealed class Host : IDisposable {
        readonly Dictionary<string,object> config,target;readonly ResidentSchema schema;readonly string root,session,generation,localOutput,output;
        readonly long hostStart;readonly int hostPid;readonly string clockId,scope;readonly double started;
        readonly BlockingCollection<Dictionary<string,object>> commands=new BlockingCollection<Dictionary<string,object>>(128);
        readonly BlockingCollection<string> audit=new BlockingCollection<string>(4096);readonly HashSet<string> usedIds=new HashSet<string>();readonly object outputLock=new object();
        readonly Dictionary<string,string> calibrationHashes=new Dictionary<string,string>();
        NamedPipeServerStream pipe;StreamWriter writer;Thread reader,monitor,auditWriter;WgcCapture capture;ResidentNativeHand hand;
        volatile bool stopping;volatile bool initializing=true;volatile string stopReason="shutdown_requested";bool stoppedWritten;double lastController;long seq;int actions;Dictionary<string,object> latest;
        readonly Dictionary<string,object> absence;readonly string absenceHash;
        readonly UiSkillVision uiSkills=new UiSkillVision();Dictionary<string,object> uiScope;
        public Host(Dictionary<string,object> config,ResidentSchema schema){
            this.config=config;this.schema=schema;target=ResidentWire.Map(config["target"]);root=AppDomain.CurrentDomain.BaseDirectory;
            session=ResidentWire.Text(config,"session_id");generation=ResidentWire.Text(config,"channel_generation");localOutput=ResidentWire.Text(config,"local_output");output=ResidentWire.Text(config,"output");scope=ResidentWire.Text(config,"target_scope");
            started=Clock.PreciseMs;hostPid=Process.GetCurrentProcess().Id;hostStart=Native.GetProcessStartTicks(hostPid);clockId=ResidentIdentity.ClockId();
            ResidentWire.Need(Process.GetCurrentProcess().SessionId==1,"host_not_session1");Native.MakeDpiAware();
            ResidentWire.Need(Path.IsPathRooted(localOutput)&&!localOutput.StartsWith("\\\\")&&!Directory.Exists(localOutput),"new_native_local_output_required");Directory.CreateDirectory(localOutput);
            ResidentWire.Need(Directory.Exists(output),"owned_output_missing");
            auditWriter=new Thread(delegate(){try{using(var log=new StreamWriter(new FileStream(Path.Combine(localOutput,"resident.jsonl"),FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false))){foreach(string line in audit.GetConsumingEnumerable())log.WriteLine(line);}}catch{Stop("audit_writer_failed");}});auditWriter.IsBackground=true;auditWriter.Start();
            var hashes=ResidentWire.Map(config["payload_hashes"]);foreach(var kv in hashes){ResidentWire.Need(System.Text.RegularExpressions.Regex.IsMatch(kv.Key,"^[A-Za-z0-9_.-]+\\.(exe|json|png)$"),"payload_name_invalid");ResidentWire.Need(ResidentWire.HashFile(Path.Combine(root,kv.Key))==(string)kv.Value,"fixed_payload_changed");}
            ResidentIdentity.TargetScope=scope;
            if(scope=="recording_fixture"){
                ResidentWire.Need(!ResidentWire.Bool(config,"focus_recovery_authorized")&&config["fixture_executable"]!=null&&hashes.ContainsKey("ResidentRecordingWindow.exe"),"fixture_focus_exception_or_identity_rejected");
                ResidentIdentity.FixtureExecutable=ResidentWire.Text(config,"fixture_executable");ResidentIdentity.FixtureHash=ResidentWire.Text(hashes,"ResidentRecordingWindow.exe");
            }else ResidentWire.Need(scope=="retail_wow"&&config["fixture_executable"]==null&&ResidentWire.Int(config,"max_actions")<=(config.ContainsKey("ui_skill_practice_authorized")&&ResidentWire.Bool(config,"ui_skill_practice_authorized")&&ResidentWire.Bool(config,"authorized_input")?32:8),"retail_scope_budget_or_fixture_rejected");
            calibrationHashes["selection"]=ResidentWire.HashFile(Path.Combine(root,"selected-alliance-warrior.json"));calibrationHashes["tutorial"]=ResidentWire.HashFile(Path.Combine(root,"tutorial-talk-jaina.json"));
            if(config["dialog_absence_calibration"]!=null){string path=ResidentWire.Text(config,"dialog_absence_calibration");absence=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(path)));schema.Definition(absence,"dialog_absence_calibration");absenceHash=ResidentWire.HashFile(path);}
            var window=ResidentIdentity.Check(target);if(scope=="retail_wow")RecoveryCvProfile.DescribeRegions(ResidentWire.Int(window,"client_width"),ResidentWire.Int(window,"client_height"),root);
            Stage="wgc_initialize";capture=new WgcCapture(ResidentIdentity.Hwnd(target));Stage="pipe_create";pipe=ResidentPipe.Create(ResidentWire.Text(config,"pipe_name"));
            ResidentWire.WriteNew(Path.Combine(output,"host-ready.json"),ResidentWire.Obj("host_pid",hostPid,"host_start_ticks",hostStart.ToString(),"session_id",session,"channel_generation",generation,"windows_clock_id",clockId,"local_output",localOutput,"started_windows_qpc_ms",started));
        }
        Dictionary<string,object> Envelope(string type,string id){var v=ResidentWire.Obj("protocol","wow-resident","version",1,"type",type,"session_id",session,"local_clock",ResidentWire.Obj("domain","windows-qpc","at_ms",Clock.PreciseMs));if(id!=null)v["id"]=id;return v;}
        void Emit(Dictionary<string,object> value){value["local_clock"]=ResidentWire.Obj("domain","windows-qpc","at_ms",Clock.PreciseMs);string line=ResidentWire.Encode(value);schema.Definition(ResidentWire.Decode(line),ResidentWire.Text(value,"type"));ResidentWire.Need(audit.TryAdd(line),"audit_queue_full");lock(outputLock){ResidentWire.Need(writer!=null,"writer_unavailable");writer.WriteLine(line);writer.Flush();}}
        void Error(string id,string reason){try{var value=Envelope("error",null);value["id"]=id;value["reason"]=ResidentWire.Obj("code",System.Text.RegularExpressions.Regex.IsMatch(reason,"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")?reason:"host_operation_failed");Emit(value);}catch{Stop("transport_failed");}}
        bool ControllerAlive(){double age=Clock.PreciseMs-lastController;return !stopping&&age>=0&&age<=(initializing?5000:750);}
        void Stop(string reason){stopReason=reason;stopping=true;if(hand!=null)hand.RequestCancel();
            if(reason=="controller_eof"||reason=="controller_heartbeat_expired"||reason=="controller_transport_failed"||reason=="run_budget_expired")try{if(pipe!=null)pipe.Dispose();}catch{}
        }
        bool Cancelled(){return stopping;}
        void Check(){ResidentWire.Need(!stopping,"cancelled");ResidentWire.Need(Clock.PreciseMs-started<=ResidentWire.Int(config,"duration_ms"),"run_budget_expired");}
        public void Run(){
            Stage="pipe_wait_for_connection";
            IAsyncResult connect=pipe.BeginWaitForConnection(null,null);double deadline=Clock.PreciseMs+30000;
            while(!connect.AsyncWaitHandle.WaitOne(50)){Check();ResidentWire.Need(Clock.PreciseMs<deadline,"controller_connect_timeout");}
            pipe.EndWaitForConnection(connect);
            Stage="pipe_client_pid";int relayPid=ResidentPipe.ClientPid(pipe);Stage="pipe_client_session";ResidentWire.Need(ResidentPipe.ClientSession(pipe)==0,"pipe_client_not_session0");var hashes=ResidentWire.Map(config["payload_hashes"]);
            var input=new StreamReader(pipe,new UTF8Encoding(false,true),false,4096,true);writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true);
            Stage="pipe_handshake";string hello=null;Exception helloError=null;var helloThread=new Thread(delegate(){try{hello=ResidentWire.ReadBounded(input,1024);}catch(Exception e){helloError=e;}});helloThread.IsBackground=true;helloThread.Start();
            double handshakeDeadline=Clock.PreciseMs+5000;while(!helloThread.Join(50)){if(Clock.PreciseMs>handshakeDeadline||Clock.PreciseMs-started>ResidentWire.Int(config,"duration_ms")){pipe.Dispose();throw new InvalidOperationException("controller_handshake_timeout");}}
            if(helloError!=null)throw helloError;ResidentWire.Need(hello!=null,"controller_handshake_eof");
            var handshake=ResidentWire.Map(ResidentWire.Decode(hello));Stage="pipe_handshake_identity";ResidentWire.Need(handshake.Count==4&&ResidentWire.Text(handshake,"nonce")==ResidentWire.Text(config,"nonce")&&ResidentWire.Text(handshake,"session_id")==session&&ResidentWire.Int(handshake,"relay_pid")==relayPid,"controller_handshake_failed");
            Stage="pipe_peer_sid";ResidentWire.WriteNew(Path.Combine(localOutput,"channel-sid.json"),ResidentPipe.VerifyCurrentSid(pipe));
            Stage="pipe_peer_identity";ResidentPipe.VerifyProcess(relayPid,Path.Combine(root,"ResidentRelay.exe"),ResidentWire.Text(hashes,"ResidentRelay.exe"));ResidentWire.Need(ResidentPipe.StartTicks(relayPid)==Int64.Parse(ResidentWire.Text(handshake,"relay_start_ticks")),"pipe_peer_start_changed");
            ResidentWire.WriteNew(Path.Combine(localOutput,"channel-peer.json"),ResidentWire.Obj("relay_pid",relayPid,"relay_start_ticks",ResidentWire.Text(handshake,"relay_start_ticks"),"relay_windows_session_id",0,"host_pid",hostPid,"host_start_ticks",hostStart.ToString(),"host_windows_session_id",1,"session_identity_api","GetNamedPipeClientSessionId","current_user_sid_verified",true,"relay_executable_sha256",ResidentWire.Text(hashes,"ResidentRelay.exe")));
            lastController=Clock.PreciseMs;
            reader=new Thread(delegate(){try{string line;while(!stopping&&(line=ResidentWire.ReadBounded(input,1048576))!=null){var command=ResidentWire.Map(ResidentWire.Decode(line));schema.Definition(command,"command");ResidentWire.Need(ResidentWire.Text(command,"session_id")==session,"controller_session_changed");lastController=Clock.PreciseMs;string op=ResidentWire.Text(command,"op");if(op=="heartbeat")continue;if(op=="shutdown"){Stop("shutdown_requested");if(!commands.TryAdd(command))break;break;}if(op=="cancel"&&hand!=null)hand.RequestCancel();ResidentWire.Need(commands.TryAdd(command),"controller_queue_full");}if(!stopping)Stop("controller_eof");}catch{Stop("controller_transport_failed");}finally{commands.CompleteAdding();}});reader.IsBackground=true;reader.Start();
            Stage="native_hand_initialize";if(ResidentWire.Bool(config,"authorized_input")){hand=new ResidentNativeHand();hand.Start(target,session,root,localOutput,ControllerAlive);}
            var ready=Envelope("ready",null);ready["target_scope"]=scope;ResidentWire.WriteNew(Path.Combine(localOutput,"desktop-diagnostic.json"),ResidentIdentity.DesktopDiagnostic());ResidentWire.WriteNew(Path.Combine(localOutput,"focus-candidates.json"),Native.GetRecoveryFocusCandidates(ResidentIdentity.Hwnd(target)));ResidentWire.WriteNew(Path.Combine(localOutput,"visibility-diagnostic.json"),Native.GetRecoveryVisibilityDiagnostic(ResidentIdentity.Hwnd(target)));ready["channel_generation"]=generation;ready["host_pid"]=hostPid;ready["host_start_ticks"]=hostStart.ToString();ready["windows_clock_id"]=clockId;ready["windows_session_id"]=1;ready["target"]=target;ready["window"]=ResidentIdentity.Check(target);ready["native_ready"]=hand==null?null:hand.Ready;ready["capabilities"]=ResidentWire.Obj("capture","wgc","fresh_frame",true,"memory_roi",true,"input",hand!=null,"max_duration_ms",config.ContainsKey("tutorial_prerequisite_authorized")&&ResidentWire.Bool(config,"tutorial_prerequisite_authorized")?950:300,"controller_lease_ms",750);Emit(ready);
            lastController=Clock.PreciseMs;initializing=false;
            monitor=new Thread(delegate(){while(!stopping){if(!ControllerAlive()){Stop("controller_heartbeat_expired");break;}if(Clock.PreciseMs-started>ResidentWire.Int(config,"duration_ms")){Stop("run_budget_expired");break;}Thread.Sleep(20);}});monitor.IsBackground=true;monitor.Start();
            Stage="ready_command_loop";while(!stopping){Dictionary<string,object> command;if(!commands.TryTake(out command,50))continue;string id=ResidentWire.Text(command,"id"),op=ResidentWire.Text(command,"op");Stage="operation_"+op;
                try{if(op=="shutdown"){stopReason="shutdown_requested";break;}ResidentWire.Need(usedIds.Add(id)&&usedIds.Count<=4096,"duplicate_or_capacity_id");Check();
                    if(op=="load_ui_skills"){uiScope=ResidentWire.Map(command["ui_scope"]);ResidentWire.Need(ResidentWire.Text(uiScope,"target_scope")==scope,"ui_scope_target_changed");var scopeWindow=ResidentIdentity.Check(target);ResidentWire.Need(ResidentWire.Text(uiScope,"size_bucket")==ResidentWire.Int(scopeWindow,"client_width")+"x"+ResidentWire.Int(scopeWindow,"client_height"),"ui_scope_size_changed");var version=System.Diagnostics.FileVersionInfo.GetVersionInfo(ResidentWire.Text(target,"executable"));ResidentWire.WriteNew(Path.Combine(localOutput,"ui-skill-scope-"+id+".json"),ResidentWire.Obj("scope",uiScope,"file_version",version.FileVersion,"product_version",version.ProductVersion,"fixed_private_part",version.FilePrivatePart));string fileVersion=(version.FileVersion??"").Replace(", ",".").Replace(",",".").Trim();string productVersion=(version.ProductVersion??"").Trim();ResidentWire.Need(fileVersion==ResidentWire.Text(uiScope,"build")||productVersion==ResidentWire.Text(uiScope,"build"),"ui_scope_build_changed");bool negative=command.ContainsKey("negative_validation_canonical");ResidentWire.Need(negative==command.ContainsKey("negative_validation_sha256"),"ui_negative_validation_pair_required");if(negative)uiSkills.LoadVerified(ResidentWire.Text(command,"snapshot_canonical"),ResidentWire.Text(command,"snapshot_sha256"),ResidentWire.Text(command,"negative_validation_canonical"),ResidentWire.Text(command,"negative_validation_sha256"));else uiSkills.Load(ResidentWire.Text(command,"snapshot_canonical"),ResidentWire.Text(command,"snapshot_sha256"));latest=null;Observe(command,false);}
                    else if(op=="observe"||op=="evidence")Observe(command,op=="evidence");
                    else if(op=="execute")Execute(command);
                    else if(op=="release_all"||op=="status"||op=="cancel"){ResidentWire.Need(hand!=null,"no_input_executor");var receipt=hand.Invoke(op,null,id,1500,Cancelled);var value=Envelope("receipt",id);value["native"]=receipt;value["source"]=null;value["intent"]=null;value["dispatch_qpc_ms"]=Clock.PreciseMs;Emit(value);}
                    else throw new InvalidOperationException("unsupported_operation");
                }catch(Exception e){try{var failure=Failure(e);if(capture!=null)failure["capture_diagnostic"]=capture.Diagnostic();failure["desktop_diagnostic"]=ResidentIdentity.DesktopDiagnostic();try{failure["window"]=ResidentIdentity.Check(target);}catch{}ResidentWire.WriteNew(Path.Combine(localOutput,"operation-error-"+id+".json"),failure);}catch{}Error(id,e is InvalidOperationException?e.Message:"host_operation_failed");if(op=="execute"||op=="release_all")Stop("input_operation_failed");}
            }
            Shutdown("stopped");
        }
        string Layout(Dictionary<string,object> window){return ResidentWire.SerializeHash(ResidentWire.Obj("width",window["client_width"],"height",window["client_height"],"dpi",window["dpi"],"client_rect",window["client_rect"],"target",target));}
        void Observe(Dictionary<string,object> command,bool evidence){
            // This timestamp is when the worker actually starts the request. It
            // is later than pipe reception, retaining the coordinator lower bound.
            double request=Clock.PreciseMs;var before=ResidentIdentity.Check(target);ResidentWire.Need(ResidentWire.Bool(before,"visible")&&!ResidentWire.Bool(before,"minimized"),"target_not_visible");
            int width=ResidentWire.Int(before,"client_width"),height=ResidentWire.Int(before,"client_height");string layout=Layout(before);
            var regions=scope=="recording_fixture"?new List<RecoveryCvRegion>{new RecoveryCvRegion{Id="recording-control",Rectangle=ResidentRecordingCv.Region}}:RecoveryCvProfile.DescribeRegions(width,height,root);var rois=new List<WgcCapture.Roi>();if(uiScope!=null)regions.AddRange(uiSkills.Regions(width,height,uiScope));
            using(var frame=capture.Fresh(request,500,Cancelled,ResidentIdentity.Hwnd(target),before))try{
                var result=Envelope("sample",ResidentWire.Text(command,"id"));long frameSeq=++seq;string frameId="frame-"+frameSeq;double roiStart=Clock.PreciseMs;var wireRois=new List<object>();var cvRegions=new List<RecoveryCvFrameRegion>();
                rois.AddRange(frame.ReadMany(regions));
                for(int ri=0;ri<regions.Count;ri++){var region=regions[ri];var roi=rois[ri];cvRegions.Add(new RecoveryCvFrameRegion{Rectangle=roi.Rectangle,Image=roi.Bitmap});string kind=region.Id.StartsWith("selection-")?"selection":"tutorial";bool learned=region.Id.StartsWith("learned-ui-");wireRois.Add(ResidentWire.Obj("id",region.Id,"x",roi.Rectangle.X,"y",roi.Rectangle.Y,"width",roi.Rectangle.Width,"height",roi.Rectangle.Height,"sha256",roi.Hash,"calibration_id",learned?"ui-skill-learning-v1":scope=="recording_fixture"?"recording-fixture-v1":kind=="selection"?"selected-alliance-warrior":"tutorial-talk-jaina","calibration_sha256",learned?uiSkills.KnowledgeSha:scope=="recording_fixture"?ResidentIdentity.FixtureHash:calibrationHashes[kind]));}
                var absenceResult=ResidentWire.Obj("status","unknown","verified",false,"reason","absence_calibration_missing","coverage_complete",false);
                if(absence!=null&&scope=="retail_wow"){absenceResult=Absence(frame,layout,width,height,rois,wireRois);}
                double roiEnd=Clock.PreciseMs,cvStart=Clock.PreciseMs;var cv=scope=="retail_wow"?RecoveryCvProfile.MatchRegions(cvRegions,width,height,root):ResidentWire.Obj("selected_character",ResidentWire.Obj("verified",false,"reason","fixture_not_game"),"tutorial_interaction",ResidentWire.Obj("verified",false,"reason","fixture_not_game"));cv["dialog_absence"]=absenceResult;
                if(scope=="recording_fixture")cv["recording_fixture"]=ResidentRecordingCv.Match(rois[0].Bitmap,width,height,layout,ResidentWire.ActionHash(ResidentWire.Obj("target_scope",scope,"target",target,"channel_generation",generation,"host_start_ticks",hostStart.ToString())),ResidentIdentity.FixtureHash);double cvEnd=Clock.PreciseMs;
                var after=ResidentIdentity.Check(target);ResidentWire.Need(Layout(after)==layout,"capture_layout_changed");
                string roiHash=ResidentWire.SerializeHash(wireRois);var memory=ResidentWire.Obj("target_scope",scope,"session_id",session,"channel_generation",generation,"host_pid",hostPid,"host_start_ticks",hostStart.ToString(),"windows_clock_id",clockId,"target",target,"frame_id",frameId,"seq",frameSeq,"layout_id",layout,"client_width",width,"client_height",height,"dpi",after["dpi"],"source_qpc_ms",frame.SourceMs,"request_received_qpc_ms",request,"roi_sha256",roiHash,"full_frame_sha256",null,"rois",wireRois);
                result["seq"]=frameSeq;result["window"]=after;result["capture"]=ResidentWire.Obj("status","ok","method","wgc","started_qpc_ms",frame.SourceMs,"finished_qpc_ms",roiEnd,"request_received_qpc_ms",request,"arrived_qpc_ms",frame.ArrivedMs,"source_qpc_basis","host_frame_arrived","render_timestamp",ResidentWire.Obj("domain","wgc-system-relative","at_ms",frame.RenderMs,"alignment","unverified"));result["metrics"]=ResidentWire.Obj("mean_luma",null,"variance_luma",null,"frame_delta",null);result["detectors"]=ResidentWire.Obj("inventory_open",ResidentWire.Obj("status","unknown","value",null,"confidence",0,"calibration_id",null));result["artifact"]=null;result["memory_frame"]=memory;result["cv"]=cv;if(uiScope!=null)result["ui_skills"]=uiSkills.Match(rois,regions,uiScope,memory);result["input_state"]=ResidentIdentity.CursorState(ResidentIdentity.Hwnd(target));result["processing_timing"]=ResidentWire.Obj("clock","windows_qpc","request_ms",request,"frame_arrived_ms",frame.ArrivedMs,"roi_started_ms",roiStart,"roi_finished_ms",roiEnd,"cv_started_ms",cvStart,"cv_finished_ms",cvEnd,"response_ms",Clock.PreciseMs);
                result["local_clock"]=ResidentWire.Obj("domain","windows-qpc","at_ms",Clock.PreciseMs);latest=ResidentWire.Map(ResidentWire.Clone(result));
                if(!evidence){Emit(result);return;}
                // Explicit low-frequency evidence only. The same checked-out GPU
                // frame supplies the full image; encoding is off the hot path.
                string path=Path.Combine(localOutput,"evidence-"+frameSeq+".png");using(var full=frame.Read(new Rectangle(0,0,width,height)))full.Bitmap.Save(path,ImageFormat.Png);
                Check();var evidenceResult=Envelope("evidence",ResidentWire.Text(command,"id"));evidenceResult["sample"]=result;evidenceResult["artifact"]=ResidentWire.Obj("id","evidence-"+frameSeq,"windows_path",path,"sha256",ResidentWire.HashFile(path),"width",width,"height",height,"source_frame_id",frameId,"source_qpc_ms",frame.SourceMs);evidenceResult["ocr"]=ResidentWire.Bool(command,"ocr")&&scope=="retail_wow"?(object)RecoveryOcr.Read(path):null;Emit(evidenceResult);
            }finally{foreach(var roi in rois)roi.Dispose();}
        }
        Dictionary<string,object> Absence(WgcCapture.Snapshot frame,string layout,int width,int height,List<WgcCapture.Roi> keep,List<object> proof){
            try{
                var client=ResidentWire.Map(absence["client"]);var coverage=ResidentWire.Map(absence["coverage"]);var source=ResidentWire.Map(absence["source"]);
                ResidentWire.Need(ResidentWire.Int(absence,"version")==1&&ResidentWire.Text(absence,"layout_id")==layout&&ResidentWire.Same(absence["target"],target)&&ResidentWire.Int(client,"width")==width&&ResidentWire.Int(client,"height")==height&&ResidentWire.Int(client,"dpi")==ResidentWire.Int(ResidentIdentity.Check(target),"dpi")&&ResidentWire.Bool(coverage,"complete")&&ResidentWire.Text(source,"windows_clock_id")==clockId,"absence_scope_unknown");
                var covering=ResidentWire.Map(coverage["rect"]);ResidentWire.Need(ResidentWire.Int(covering,"x")==0&&ResidentWire.Int(covering,"y")==0&&ResidentWire.Int(covering,"width")==checked((int)Math.Ceiling(width*.45))&&ResidentWire.Int(covering,"height")==checked((int)Math.Ceiling(height*.90)),"absence_coverage_unknown");
                bool matched=true;var rows=absence["regions"]as object[];ResidentWire.Need(rows!=null&&rows.Length==1,"absence_regions_unknown");var scores=new List<object>();
                foreach(object item in rows){var region=ResidentWire.Map(item);ResidentWire.Need(ResidentWire.Same(region["rect"],covering),"absence_coverage_incomplete");string id=ResidentWire.Text(region,"id");var rectangle=ResidentWire.Map(region["rect"]);var rect=new Rectangle(ResidentWire.Int(rectangle,"x"),ResidentWire.Int(rectangle,"y"),ResidentWire.Int(rectangle,"width"),ResidentWire.Int(rectangle,"height"));var roi=frame.Read(rect);keep.Add(roi);bool equal=roi.Hash==ResidentWire.Text(region,"raw_bgra8_opaque_sha256");matched&=equal;proof.Add(ResidentWire.Obj("id","dialog-absence-"+id,"x",rect.X,"y",rect.Y,"width",rect.Width,"height",rect.Height,"sha256",roi.Hash,"calibration_id","reviewed-dialog-absence","calibration_sha256",absenceHash));scores.Add(ResidentWire.Obj("id",id,"live_rect",rectangle,"matched",equal));}
                return ResidentWire.Obj("status",matched?"known":"unknown","verified",matched,"dialog_open",matched?(object)false:null,"reason",matched?"exact_reviewed_roi_match":"reviewed_roi_changed","coverage_complete",matched,"calibration_sha256",absenceHash,"regions",scores);
            }catch{return ResidentWire.Obj("status","unknown","verified",false,"reason","absence_scope_or_calibration_unknown","coverage_complete",false);}
        }
        internal static bool ReviewedCameraSweep(Dictionary<string,object> action,int width,int height) {
            if(ResidentWire.Text(action,"kind")!="timeline"||ResidentWire.Int(action,"duration_ms")!=950)return false;
            var events=action["events"] as object[];if(events==null||events.Length!=11)return false;
            var move=ResidentWire.Map(events[0]);var down=ResidentWire.Map(events[1]);var up=ResidentWire.Map(events[10]);
            if(ResidentWire.Text(move,"kind")!="absolute_mouse_move"||ResidentWire.Int(move,"at_ms")!=0||ResidentWire.Int(move,"x")!=(int)Math.Floor(width*.70)||ResidentWire.Int(move,"y")!=(int)Math.Floor(height*.62)||ResidentWire.Text(down,"kind")!="button_down"||ResidentWire.Text(down,"button")!="right"||ResidentWire.Int(down,"at_ms")!=150||ResidentWire.Text(up,"kind")!="button_up"||ResidentWire.Text(up,"button")!="right"||ResidentWire.Int(up,"at_ms")!=950)return false;
            int sum=0,outward=0;for(int i=0;i<8;i++){var e=ResidentWire.Map(events[i+2]);int dx=ResidentWire.Int(e,"dx");if(ResidentWire.Text(e,"kind")!="relative_mouse_move"||ResidentWire.Int(e,"at_ms")!=250+i*100||ResidentWire.Int(e,"dy")!=0||Math.Abs(dx)>512||(i<4?dx<=0:dx>=0))return false;sum+=dx;if(i<4)outward+=dx;}
            return sum==0&&outward==(int)Math.Round(width*.12,MidpointRounding.AwayFromZero);
        }
        void Execute(Dictionary<string,object> command){
            ResidentWire.Need(hand!=null&&ResidentWire.Bool(config,"authorized_input"),"input_not_authorized");ResidentWire.Need(actions<ResidentWire.Int(config,"max_actions"),"action_budget_exhausted");
            ResidentWire.Need(latest!=null&&ResidentWire.Same(command["source"],latest["memory_frame"]),"source_not_registered");if(latest.ContainsKey("ui_skills"))ResidentWire.Need(!ResidentWire.Bool(ResidentWire.Map(latest["ui_skills"]),"hard_stop"),"ui_hard_stop");var source=ResidentWire.Map(command["source"]);var action=ResidentWire.Map(command["action"]);var intent=ResidentWire.Map(command["intent"]);
            ResidentWire.Need(ResidentWire.Text(intent,"intent_id")==ResidentWire.Text(command,"id")&&ResidentWire.Text(intent,"action_sha256")==ResidentWire.ActionHash(action),"approved_action_binding_changed");if(intent.ContainsKey("ui_skill")){var binding=ResidentWire.Map(intent["ui_skill"]);ResidentWire.Need(binding.Count==3&&ResidentWire.Text(binding,"knowledge_sha256")==uiSkills.KnowledgeSha,"ui_skill_knowledge_changed");string route=ResidentWire.Text(binding,"route");ResidentWire.Need(route=="reflex"||route=="slow_path","ui_skill_route_invalid");ResidentWire.Need(latest.ContainsKey("ui_skills"),"ui_skill_source_missing");if(route=="reflex")uiSkills.VerifyReflex(binding,ResidentWire.Map(latest["ui_skills"]),action,source);else uiSkills.VerifySlowSkill(binding,ResidentWire.Map(latest["ui_skills"]));}
            double age=Clock.PreciseMs-ResidentWire.Num(source,"source_qpc_ms");ResidentWire.Need(age>=0&&age<=750,"source_expired");var window=ResidentIdentity.Check(target);ResidentWire.Need(Layout(window)==ResidentWire.Text(source,"layout_id"),"input_layout_changed");
            string kind=ResidentWire.Text(action,"kind");int actionDuration=ResidentWire.Int(action,"duration_ms");ResidentWire.Need(actionDuration>=1&&actionDuration<=950,"finite_action_bounds");
            bool camera=actionDuration>300;
            if(camera) {
                ResidentWire.Need(config.ContainsKey("tutorial_prerequisite_authorized")&&ResidentWire.Bool(config,"tutorial_prerequisite_authorized")&&scope=="retail_wow","tutorial_camera_not_authorized");
                var learned=ResidentWire.Map(latest["ui_skills"]);ResidentWire.Need(ResidentWire.Text(learned,"status")=="known"&&ResidentWire.Text(learned,"state_id")=="tutorial_look_around","tutorial_camera_current_state_required");
                ResidentWire.Need(ReviewedCameraSweep(action,ResidentWire.Int(source,"client_width"),ResidentWire.Int(source,"client_height")),"tutorial_camera_shape_invalid");
            } else if(actionDuration>150) {
                ResidentWire.Need(kind=="timeline","finite_action_bounds");var events=action["events"] as object[];ResidentWire.Need(events!=null&&events.Length==3,"finite_action_bounds");
                var move=ResidentWire.Map(events[0]);var down=ResidentWire.Map(events[1]);var up=ResidentWire.Map(events[2]);
                ResidentWire.Need(ResidentWire.Text(move,"kind")=="absolute_mouse_move"&&ResidentWire.Int(move,"at_ms")==0&&ResidentWire.Text(down,"kind")=="button_down"&&ResidentWire.Int(down,"at_ms")==150&&ResidentWire.Text(up,"kind")=="button_up"&&ResidentWire.Text(up,"button")==ResidentWire.Text(down,"button")&&ResidentWire.Int(up,"at_ms")==actionDuration&&actionDuration-150>=80&&actionDuration-150<=150,"finite_action_bounds");
            }
            if(kind=="focus_click")ResidentWire.Need(ResidentWire.Bool(config,"focus_recovery_authorized")&&ResidentWire.Text(intent,"task_id")=="session-recovery","focus_recovery_not_authorized");
            else ResidentWire.Need(ResidentWire.Bool(window,"focused"),"target_unfocused");
            ResidentWire.Need(ResidentWire.Bool(window,"visible")&&!ResidentWire.Bool(window,"minimized"),"target_not_visible");
            bool mouse=kind=="mouse_click"||kind=="focus_click"||kind=="timeline"&&((object[])action["events"]).Any(row=>ResidentWire.Text(ResidentWire.Map(row),"kind")=="button_down");
            if(mouse&&kind!="focus_click"){var cursor=ResidentIdentity.CursorState(ResidentIdentity.Hwnd(target));ResidentWire.Need(ResidentWire.Text(cursor,"status")=="known"&&ResidentWire.Bool(cursor,"cursor_free")&&!ResidentWire.Bool(cursor,"mouse_buttons_held"),"cursor_or_user_buttons_unsafe");}
            if(kind=="timeline")foreach(object row in (object[])action["events"]){var ev=ResidentWire.Map(row);if(ResidentWire.Text(ev,"kind")=="absolute_mouse_move")ResidentWire.Need(Native.RecoveryPointOwnedByWindow(ResidentIdentity.Hwnd(target),ResidentWire.Int(ev,"x"),ResidentWire.Int(ev,"y")),"input_point_not_target");}
            if(kind=="mouse_click")ResidentWire.Need(Native.RecoveryPointOwnedByWindow(ResidentIdentity.Hwnd(target),ResidentWire.Int(action,"x"),ResidentWire.Int(action,"y")),"input_point_not_target");
            Check();double dispatch=Clock.PreciseMs;actions++;var receipt=hand.Invoke("execute",action,ResidentWire.Text(command,"id"),2200,Cancelled);var result=Envelope("receipt",ResidentWire.Text(command,"id"));result["native"]=receipt;result["source"]=source;result["intent"]=intent;result["dispatch_qpc_ms"]=dispatch;Emit(result);
            ResidentWire.Need(ResidentWire.Bool(ResidentWire.Map(receipt["input"]),"released"),"native_release_unconfirmed");
            string status=ResidentWire.Text(receipt,"status");ResidentWire.Need(status=="completed"||status=="cancelled","native_action_not_completed");
        }
        void Shutdown(string id){
            if(stoppedWritten)return;stopping=true;if(hand!=null)hand.Close();if(capture!=null){capture.Dispose();capture=null;}
            var value=Envelope("stopped",id);value["reason"]=stopReason;value["release_confirmed"]=hand==null||hand.ReleaseConfirmed;value["release_receipt"]=hand==null?null:hand.ReleaseReceipt;value["ledger_empty"]=hand==null?null:hand.LedgerEmpty;value["native_exited"]=hand==null?null:hand.NativeExited;value["capture_disposed"]=true;
            ResidentWire.WriteNew(Path.Combine(localOutput,"stopped.json"),value);stoppedWritten=true;
            try{if(writer!=null&&pipe!=null&&pipe.IsConnected)Emit(value);}catch{}
        }
        public void Dispose(){
            if(!stopping)Stop("host_exiting");if(capture!=null||hand!=null){try{Shutdown("stopped");}catch{}}
            if(hand!=null){hand.Dispose();hand=null;}if(pipe!=null){pipe.Dispose();pipe=null;}commands.CompleteAdding();audit.CompleteAdding();if(auditWriter!=null)auditWriter.Join(500);
            // UNC export is best effort after release, never a release dependency.
            var export=new Thread(delegate(){try{foreach(string path in Directory.GetFiles(localOutput)){string dest=Path.Combine(output,Path.GetFileName(path));if(!File.Exists(dest))File.Copy(path,dest,false);}}catch{}});export.IsBackground=true;export.Start();export.Join(500);
        }
        public void RecordFailure(Exception error){try{ResidentWire.WriteNew(Path.Combine(localOutput,"host-error.json"),Failure(error));}catch{}Stop("host_operation_failed");}
    }
    [MTAThread] static int Main(string[] args){Host host=null;Dictionary<string,object> config=null;try{
        ResidentWire.Need(args.Length==4&&args[0]=="--config"&&args[2]=="--config-sha256","host_fixed_options");ResidentWire.Need(ResidentWire.HashFile(args[1])==args[3],"host_config_changed");
        var root=AppDomain.CurrentDomain.BaseDirectory;config=ResidentWire.Map(ResidentWire.Decode(File.ReadAllText(args[1])));var schema=new ResidentSchema(Path.Combine(root,"resident-session-v1.schema.json"),Path.Combine(root,"native-input-v1.schema.json"));schema.Definition(config,"launch_config");
        host=new Host(config,schema);host.Run();return 0;
    }catch(Exception e){if(host!=null){host.RecordFailure(e);host.Dispose();host=null;}else try{if(config!=null){string local=ResidentWire.Text(config,"local_output");if(Directory.Exists(local)){var error=Failure(e);ResidentWire.WriteNew(Path.Combine(local,"host-error.json"),error);var export=new Thread(delegate(){try{ResidentWire.WriteNew(Path.Combine(ResidentWire.Text(config,"output"),"host-error.json"),error);}catch{}});export.IsBackground=true;export.Start();export.Join(500);}}}catch{}return 2;}finally{if(host!=null)host.Dispose();}}
}
