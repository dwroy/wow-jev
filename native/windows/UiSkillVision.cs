// Read-only learned UI matcher. Knowledge may propose no input; Body/hand retain authority.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Text;

sealed class UiSkillVision
{
    public const string ChromaAlgorithm="chroma_surface_v1:rgb/(r+g+b);bins8x8x8;32x16-nearest;tv0.15;bt601_population_luma_variance300";
    public const string GreenAlgorithm="green_mask_v1:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;shift3;iou0.9";
    public const string GreenTolerantAlgorithm="green_glyph_tolerant_v2:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.65;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25";
    public const string GreenTolerantV3Algorithm="green_glyph_tolerant_v3:g>=60,g>r*1.3,g>b*1.3;msb0-row-major;min100;dilation-chebyshev-radius1;shift3;raw_iou0.5;bidirectional_coverage_min0.95;live_source_fg_ratio0.8:1.25";
    public const string ModalAlgorithm="neutral_panel_components_v1:tile8;sample-step2;rgb-chroma28;neutral-fraction0.875;bt601-variance64;component-fill0.8;min-width0.16;min-height0.10;central0.15,0.10,0.70,0.80;exclude-client-border;expected-iou0.85;one-to-one";
    sealed class Entry { public string Id,State,Signature,SignatureSha,Status,Metric="rgb_exact_v1",Algorithm,NpcName,NpcMethod,EligibilityReason="negative_validation_missing",SourceCaptureSha; public int NpcAnchor=-1; public bool HardStop,SupervisorReviewed,ActiveQualified,RecognizeApproved; public Dictionary<string,object> Box,Scope,ModalGuard,Element,Action,RawSignature,AuthorityReview; public byte[] Template,Mask; public int Width,Height,MaskWidth,MaskHeight,ReferenceWidth,ReferenceHeight; public Rectangle? ReferenceRect,NeutralGoldRect; public bool[] NeutralNameMask; public double MaxError,MaxFraction; public List<Entry> Anchors=new List<Entry>(); public HashSet<string> RequiredStates=new HashSet<string>(); }
    readonly List<Entry> entries=new List<Entry>();
    readonly List<object> quarantine=new List<object>();
    public string KnowledgeSha {get;private set;}
    public string SourceKnowledgeSha {get;private set;}
    public string NegativeValidationSha {get;private set;}
    public IList<object> Quarantine {get{return quarantine.AsReadOnly();}}
    public void Load(string canonical,string sha) {
        ResidentWire.Need(canonical.Length<=262144&&Encoding.UTF8.GetByteCount(canonical)<=786432&&ResidentWire.Hash(Encoding.UTF8.GetBytes(canonical))==sha,"ui_knowledge_sha_changed");
        var body=ResidentWire.Map(ResidentWire.Decode(canonical));ResidentWire.Need(ResidentWire.Text(body,"protocol")=="wow-ui-skill-snapshot"&&ResidentWire.Int(body,"version")==1,"ui_knowledge_protocol");
        bool features=false;if(body.ContainsKey("feature_policy")){var policy=ResidentWire.Map(body["feature_policy"]);ResidentWire.Need(policy.Count==2&&ResidentWire.Text(policy,"command")=="talk"&&ResidentWire.Text(policy,"scope")=="talk_jaina_layered","ui_feature_policy_rejected");features=true;}
        SourceKnowledgeSha=body.ContainsKey("source_knowledge_sha")?ResidentWire.Text(body,"source_knowledge_sha"):sha;ResidentWire.Need(IsSha(SourceKnowledgeSha),"ui_source_knowledge_sha_invalid");NegativeValidationSha=null;quarantine.Clear();
        var skills=body["skills"] as object[];ResidentWire.Need(skills!=null&&skills.Length<=24,"ui_signature_capacity");var next=new List<Entry>();
        foreach(object row in skills) {
          try {
            var skill=ResidentWire.Map(row);var sig=ResidentWire.Map(skill["signature"]);var review=sig.ContainsKey("review")?ResidentWire.Map(sig["review"]):ResidentWire.Obj("status","pending","reviewer","unreviewed");string status=ResidentWire.Text(skill,"status");
            bool hardStop=ResidentWire.Bool(skill,"hard_stop");
            // Safety templates are visual evidence, not approval authority.
            // A pending/rejected review must never suppress a matching stop.
            ResidentWire.Need(status=="active"||status=="candidate"||status=="hard_stop"||status=="pending_review","ui_signature_status_invalid");
            var e=new Entry{Id=ResidentWire.Text(skill,"skill_id"),State=ResidentWire.Text(skill,"state_id"),Signature=ResidentWire.Text(sig,"signature_id"),Status=status,HardStop=ResidentWire.Bool(skill,"hard_stop"),Box=ResidentWire.Map(sig["bbox"]),Scope=ResidentWire.Map(skill["scope"]),Width=ResidentWire.Int(sig,"template_width"),Height=ResidentWire.Int(sig,"template_height"),MaxError=ResidentWire.Num(sig,"max_mean_abs_error"),MaxFraction=ResidentWire.Num(sig,"max_fraction_above_24")};
            e.SignatureSha=sig.ContainsKey("sha256")?ResidentWire.Text(sig,"sha256"):null;e.SourceCaptureSha=sig.ContainsKey("source_capture_sha256")?ResidentWire.Text(sig,"source_capture_sha256"):null;
            e.RawSignature=sig;
            if(skill.ContainsKey("element"))e.Element=ResidentWire.Map(skill["element"]);if(skill.ContainsKey("action")&&skill["action"]!=null)e.Action=ResidentWire.Map(skill["action"]);
            var authority=skill.ContainsKey("review")?ResidentWire.Map(skill["review"]):review;e.SupervisorReviewed=ResidentWire.Text(authority,"status")=="approved"&&(ResidentWire.Text(authority,"reviewer")=="user"||ResidentWire.Text(authority,"reviewer")=="claude");
            e.AuthorityReview=authority;
            bool revoked=skill.ContainsKey("governance")&&ResidentWire.Map(skill["governance"]).ContainsKey("user_revoked")&&ResidentWire.Bool(ResidentWire.Map(skill["governance"]),"user_revoked");
            // Pending model/self proposals may be recognized from actual new
            // pixels under autonomous policy; recognition never grants active.
            e.RecognizeApproved=hardStop||!revoked&&ResidentWire.Text(review,"status")!="rejected";
            if(e.State=="in_world"&&!hardStop){quarantine.Add(ResidentWire.Obj("skill_id",e.Id,"reason","generic_in_world_requires_independent_world_detector"));e.RecognizeApproved=false;}
            ResidentWire.Need(e.Width>=1&&e.Width<=64&&e.Height>=1&&e.Height<=32&&e.MaxError>=0&&e.MaxError<=12&&e.MaxFraction>=0&&e.MaxFraction<=.1,"ui_template_bounds");
            e.Template=Convert.FromBase64String(ResidentWire.Text(sig,"rgb_base64"));ResidentWire.Need(e.Template.Length==e.Width*e.Height*3&&ResidentWire.Hash(e.Template)==ResidentWire.Text(sig,"template_sha256"),"ui_template_sha_changed");
            Feature(e,sig,false,features);
            Reference(e,sig);
            RectangleFor(e.Box,2560,1440);
            if(sig.ContainsKey("anchors"))foreach(object rawAnchor in (object[])sig["anchors"]) {
                var a=ResidentWire.Map(rawAnchor);var anchor=new Entry{Id=e.Id+"-anchor-"+e.Anchors.Count,Box=ResidentWire.Map(a["bbox"]),Scope=e.Scope,Width=ResidentWire.Int(a,"template_width"),Height=ResidentWire.Int(a,"template_height"),MaxError=ResidentWire.Num(a,"max_mean_abs_error"),MaxFraction=ResidentWire.Num(a,"max_fraction_above_24")};
                ResidentWire.Need(anchor.Width>=1&&anchor.Width<=64&&anchor.Height>=1&&anchor.Height<=32&&anchor.MaxError>=0&&anchor.MaxError<=12&&anchor.MaxFraction>=0&&anchor.MaxFraction<=.1&&e.Anchors.Count<8,"ui_anchor_bounds");
                anchor.Template=Convert.FromBase64String(ResidentWire.Text(a,"rgb_base64"));ResidentWire.Need(anchor.Template.Length==anchor.Width*anchor.Height*3&&ResidentWire.Hash(anchor.Template)==ResidentWire.Text(a,"template_sha256"),"ui_anchor_sha_changed");Feature(anchor,a,true,features&&e.State=="tutorial_talk_jaina");Reference(anchor,a);RectangleFor(anchor.Box,2560,1440);e.Anchors.Add(anchor);
            }
            if(sig.ContainsKey("npc_locator")){
                var locator=ResidentWire.Map(sig["npc_locator"]);
                string method=ResidentWire.Text(locator,"method");e.NpcMethod=method;
                e.NpcName=ResidentWire.Text(locator,"name");e.NpcAnchor=ExactInteger(locator,"anchor_index",0,e.Anchors.Count-1);
                if(method=="current_neutral_nameplate_v1"){
                    ResidentWire.Need(locator.Count==6&&e.State=="tutorial_attack_training"&&ResidentWire.Text(e.Scope,"target_scope")=="retail_wow"&&e.NpcName=="作战假人"&&e.Element!=null&&ResidentWire.Text(e.Element,"purpose")=="engage_training_dummy_layered"&&e.Anchors.Count>=2&&e.Width==32&&e.Height==16&&e.Anchors[e.NpcAnchor].Metric=="rgb_exact_v1"&&e.ReferenceRect.HasValue&&e.Anchors[e.NpcAnchor].ReferenceRect.HasValue,"ui_dummy_locator_scope_rejected");
                    ResidentWire.Need(ResidentWire.Text(locator,"algorithm_sha256")==ResidentWire.Hash(Encoding.UTF8.GetBytes(TrainingDummyVision.Algorithm)),"ui_dummy_locator_algorithm_changed");
                    var gold=ResidentWire.Map(locator["source_gold_rect"]);ResidentWire.Need(gold.Count==4,"ui_dummy_gold_rect_shape");e.NeutralGoldRect=new Rectangle(ExactInteger(gold,"x",0,e.ReferenceWidth-1),ExactInteger(gold,"y",0,e.ReferenceHeight-1),ExactInteger(gold,"width",90,350),ExactInteger(gold,"height",8,40));ResidentWire.Need(e.NeutralGoldRect.Value.Right<=e.ReferenceWidth&&e.NeutralGoldRect.Value.Bottom<=e.ReferenceHeight,"ui_dummy_gold_rect_bounds");
                    var mask=ResidentWire.Map(locator["mask"]);var name=e.Anchors[e.NpcAnchor].ReferenceRect.Value;ResidentWire.Need(mask.Count==5&&ResidentWire.Text(mask,"packing")=="msb0-row-major"&&ExactInteger(mask,"width",1,180)==name.Width&&ExactInteger(mask,"height",1,48)==name.Height,"ui_dummy_name_mask_geometry");
                    var raw=Convert.FromBase64String(ResidentWire.Text(mask,"base64"));ResidentWire.Need(raw.Length==(name.Width*name.Height+7)/8&&ResidentWire.Hash(raw)==ResidentWire.Text(mask,"sha256"),"ui_dummy_name_mask_sha");e.NeutralNameMask=new bool[name.Width*name.Height];int foreground=0;for(int i=0;i<e.NeutralNameMask.Length;i++){e.NeutralNameMask[i]=(raw[i/8]&(128>>(i%8)))!=0;if(e.NeutralNameMask[i])foreground++;}ResidentWire.Need(foreground>=100,"ui_dummy_name_mask_empty");for(int i=e.NeutralNameMask.Length;i<raw.Length*8;i++)ResidentWire.Need((raw[i/8]&(128>>(i%8)))==0,"ui_dummy_name_mask_padding");
                }else{
                    ResidentWire.Need(locator.Count==3&&ResidentWire.Text(locator,"method")=="current_nameplate_yellow_outline_v1"&&features&&e.State=="tutorial_talk_jaina"&&e.Metric=="chroma_surface_v1"&&ResidentWire.Text(e.Scope,"target_scope")=="retail_wow","ui_npc_locator_scope_rejected");
                    e.NpcName=ResidentWire.Text(locator,"name");e.NpcAnchor=ExactInteger(locator,"anchor_index",0,e.Anchors.Count-1);
                    ResidentWire.Need(e.NpcName=="吉安娜·普罗德摩尔"&&e.Anchors[e.NpcAnchor].Metric=="green_glyph_tolerant_v3"&&e.Anchors.Count>=2&&e.Anchors.Any(a=>a.Metric=="rgb_exact_v1")&&e.ReferenceRect.HasValue&&e.Anchors[e.NpcAnchor].ReferenceRect.HasValue,"ui_npc_locator_proofs_missing");
                }
            }
            if(sig.ContainsKey("modal_guard")){e.ModalGuard=ResidentWire.Map(sig["modal_guard"]);ValidateModalGuard(e);}
            next.Add(e);
          }catch(Exception error){quarantine.Add(ResidentWire.Obj("reason","invalid_signature","error_type",error.GetType().Name,"detail",error.Message));}
        }
        entries.Clear();entries.AddRange(next);KnowledgeSha=sha;
    }
    static bool IsSha(string value){if(value==null||value.Length!=64)return false;foreach(char c in value)if(!(c>='0'&&c<='9'||c>='a'&&c<='f'))return false;return true;}
    public static string ModalAlgorithmSha(){return ResidentWire.Hash(Encoding.UTF8.GetBytes(ModalAlgorithm));}
    static void ValidateModalGuard(Entry entry){
        var guard=entry.ModalGuard;ResidentWire.Need((guard.Count==5||guard.Count==6&&guard.ContainsKey("review"))&&ResidentWire.Text(guard,"method")=="neutral_panel_components_v1"&&ResidentWire.Text(guard,"algorithm_sha256")==ModalAlgorithmSha()&&IsSha(entry.SourceCaptureSha)&&ResidentWire.Text(guard,"source_capture_sha256")==entry.SourceCaptureSha,"ui_modal_guard_source_changed");
        var expected=guard["expected_panels"] as object[];var negatives=guard["negative_artifacts"] as object[];ResidentWire.Need(expected!=null&&expected.Length<=8&&negatives!=null&&negatives.Length>=1&&negatives.Length<=32,"ui_modal_guard_capacity");
        foreach(object item in expected)RectangleFor(ResidentWire.Map(item),2560,1440);
        var hashes=new HashSet<string>();foreach(object raw in negatives){var proof=ResidentWire.Map(raw);string sha=ResidentWire.Text(proof,"sha256");ResidentWire.Need(proof.Count==2&&IsSha(sha)&&hashes.Add(sha)&&sha!=entry.SourceCaptureSha&&!String.IsNullOrWhiteSpace(ResidentWire.Text(proof,"path")),"ui_modal_negative_artifact_invalid");}
        if(guard.ContainsKey("review")){var review=ResidentWire.Map(guard["review"]);ResidentWire.Need(review.Count==3&&ResidentWire.Text(review,"status")!="rejected"&&new[]{"user","claude","self","seed","seed_model","root","unreviewed"}.Contains(ResidentWire.Text(review,"reviewer"))&&(review["report_sha256"]==null||IsSha(ResidentWire.Text(review,"report_sha256"))),"ui_modal_guard_provenance_invalid");}
    }
    // This bounded heuristic detects large neutral low-texture rectangular
    // panels in the central client. It is not a universal modal detector.
    public static List<Rectangle> DetectModalPanels(byte[] bgra,int width,int height){
        ResidentWire.Need(width>=16&&height>=16&&width<=7680&&height<=4320&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_modal_pixels_shape");
        int cw=(width+7)/8,ch=(height+7)/8;var cells=new bool[cw*ch];
        for(int cy=0;cy<ch;cy++)for(int cx=0;cx<cw;cx++){
            int count=0,neutral=0;double sum=0,squares=0;
            for(int y=cy*8;y<Math.Min(height,cy*8+8);y+=2)for(int x=cx*8;x<Math.Min(width,cx*8+8);x+=2){int p=(y*width+x)*4,r=bgra[p+2],g=bgra[p+1],b=bgra[p];double l=.299*r+.587*g+.114*b;count++;sum+=l;squares+=l*l;if(Math.Max(r,Math.Max(g,b))-Math.Min(r,Math.Min(g,b))<=28)neutral++;}
            double mean=sum/count,variance=Math.Max(0,squares/count-mean*mean);cells[cy*cw+cx]=(double)neutral/count>=.875&&variance<=64;
        }
        var visited=new bool[cells.Length];var panels=new List<Rectangle>();var central=new Rectangle((int)(width*.15),(int)(height*.10),(int)(width*.70),(int)(height*.80));
        for(int at=0;at<cells.Length;at++)if(cells[at]&&!visited[at]){
            var queue=new Queue<int>();queue.Enqueue(at);visited[at]=true;int minX=cw,minY=ch,maxX=0,maxY=0,count=0;
            while(queue.Count>0){int p=queue.Dequeue(),x=p%cw,y=p/cw;count++;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);
                for(int i=0;i<4;i++){int nx=x+(i==0?-1:i==1?1:0),ny=y+(i==2?-1:i==3?1:0);if(nx>=0&&ny>=0&&nx<cw&&ny<ch){int q=ny*cw+nx;if(cells[q]&&!visited[q]){visited[q]=true;queue.Enqueue(q);}}}
            }
            int cellsWide=maxX-minX+1,cellsHigh=maxY-minY+1;var rect=new Rectangle(minX*8,minY*8,Math.Min(width,(maxX+1)*8)-minX*8,Math.Min(height,(maxY+1)*8)-minY*8);
            if(minX>0&&minY>0&&maxX<cw-1&&maxY<ch-1&&rect.Width>=width*.16&&rect.Height>=height*.10&&(double)count/(cellsWide*cellsHigh)>=.8&&rect.IntersectsWith(central))panels.Add(rect);
        }return panels;
    }
    public static Dictionary<string,object> CheckModal(byte[] pixels,int width,int height,object[] expected){
        var panels=DetectModalPanels(pixels,width,height);var expectedRects=expected.Select(item=>RectangleFor(ResidentWire.Map(item),width,height)).ToArray();var used=new HashSet<int>();bool matched=true;
        foreach(var panel in panels){int found=-1;for(int i=0;i<expectedRects.Length;i++){Rectangle overlap=Rectangle.Intersect(panel,expectedRects[i]);double iou=(double)(overlap.Width*overlap.Height)/(panel.Width*panel.Height+expectedRects[i].Width*expectedRects[i].Height-overlap.Width*overlap.Height);if(iou>=.85){if(found>=0){matched=false;break;}found=i;}}
            if(found<0||!used.Add(found))matched=false;
        }
        matched&=used.Count==expectedRects.Length;
        return ResidentWire.Obj("status",matched?"clear":"present","method","neutral_panel_components_v1","algorithm_sha256",ModalAlgorithmSha(),"scope","central_large_neutral_low_texture_panels","panels",panels.Select(r=>(object)Rect(r)).ToArray(),"expected_panels",expected,"reason",matched?"actual_panels_match_reviewed_scene":"new_missing_changed_or_ambiguous_panel");
    }
    public void LoadVerified(string canonical,string sha,string negativeCanonical,string negativeSha){
        Load(canonical,sha);
        ResidentWire.Need(negativeCanonical.Length<=262144&&Encoding.UTF8.GetByteCount(negativeCanonical)<=786432&&IsSha(negativeSha)&&ResidentWire.Hash(Encoding.UTF8.GetBytes(negativeCanonical))==negativeSha,"ui_negative_validation_sha_changed");
        var body=ResidentWire.Map(ResidentWire.Decode(negativeCanonical));ResidentWire.Need(ResidentWire.Text(body,"protocol")=="wow-ui-negative-validation"&&ResidentWire.Int(body,"version")==1&&ResidentWire.Text(body,"snapshot_sha256")==SourceKnowledgeSha,"ui_negative_source_changed");
        var algorithm=ResidentWire.Map(body["algorithm"]);ResidentWire.Need(algorithm.Count==7&&ResidentWire.Text(algorithm,"id")=="ui-cell-center-rgb-32x16-v1"&&ResidentWire.Int(algorithm,"grid_width")==32&&ResidentWire.Int(algorithm,"grid_height")==16&&ResidentWire.Text(algorithm,"channel_order")=="RGB"&&ResidentWire.Text(algorithm,"bbox_rounding")=="floor-left-top-ceil-right-bottom"&&ResidentWire.Text(algorithm,"sampling")=="floor-cell-center"&&ResidentWire.Int(algorithm,"fraction_error_threshold")==24,"ui_negative_algorithm_changed");
        string corpusText=RootJsonValue(negativeCanonical,"corpus");ResidentWire.Need(ResidentWire.Hash(Encoding.UTF8.GetBytes(corpusText))==ResidentWire.Text(body,"corpus_sha256"),"ui_negative_corpus_sha_changed");
        var corpus=body["corpus"] as object[];var profiles=body["skills"] as object[];ResidentWire.Need(corpus!=null&&corpus.Length<=512&&profiles!=null&&profiles.Length<=512,"ui_negative_capacity");
        foreach(var entry in entries){
            if(entry.Status!="active"||entry.HardStop){entry.EligibilityReason=entry.HardStop?"hard_stop_has_no_input_authority":"candidate_not_active";continue;}
            try{Qualify(entry,profiles,corpus);ResidentWire.Need(entry.RequiredStates.All(state=>entries.Any(other=>other.State==state&&ResidentWire.Same(other.Scope,entry.Scope))),"ui_known_state_templates_not_loaded");}
            catch(Exception error){entry.ActiveQualified=false;entry.EligibilityReason=error.Message;quarantine.Add(ResidentWire.Obj("skill_id",entry.Id,"reason","invalid_negative_profile","error_type",error.GetType().Name,"detail",error.Message));}
        }NegativeValidationSha=negativeSha;
    }
    // Extract the original canonical JSON value bytes. Re-serializing doubles
    // via .NET would change Python's source hash (e.g. 1.0 to 1).
    static string RootJsonValue(string json,string property){
        string marker="\""+property+"\":";int start=json.IndexOf(marker,StringComparison.Ordinal);ResidentWire.Need(start>=0,"ui_negative_corpus_missing");start+=marker.Length;
        ResidentWire.Need(start<json.Length&&(json[start]=='['||json[start]=='{'),"ui_negative_corpus_shape");int depth=0;bool quoted=false,escaped=false;
        for(int i=start;i<json.Length;i++){char c=json[i];if(quoted){if(escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='\"')quoted=false;continue;}if(c=='\"'){quoted=true;continue;}if(c=='['||c=='{')depth++;else if(c==']'||c=='}'){depth--;if(depth==0)return json.Substring(start,i-start+1);}}
        throw new InvalidOperationException("ui_negative_corpus_unclosed");
    }
    static void Qualify(Entry entry,object[] profiles,object[] corpus){
        ResidentWire.Need(entry.Status=="active"&&!entry.HardStop&&entry.RecognizeApproved&&IsSha(entry.SignatureSha),"ui_entry_not_objectively_active");
        ResidentWire.Need(entry.Metric=="rgb_exact_v1"&&entry.Width==32&&entry.Height==16&&entry.Anchors.Count>=1&&entry.Anchors.All(a=>a.Metric=="rgb_exact_v1"&&a.Width==32&&a.Height==16)&&entry.NpcAnchor<0,"ui_derived_or_unanchored_active_unsupported");
        ResidentWire.Need(entry.Element!=null&&!new[]{"npc_interact","talk_jaina_layered","talk_to","interact_npc"}.Contains(ResidentWire.Text(entry.Element,"purpose")),"ui_npc_fixed_element_reflex_forbidden");
        var matching=profiles.Select(row=>ResidentWire.Map(row)).Where(p=>ResidentWire.Text(p,"skill_id")==entry.Id).ToArray();ResidentWire.Need(matching.Length==1,"ui_negative_profile_not_unique");var profile=matching[0];
        ResidentWire.Need(ResidentWire.Text(profile,"state_id")==entry.State&&ResidentWire.Same(profile["scope"],entry.Scope)&&ResidentWire.Text(profile,"signature_sha256")==entry.SignatureSha,"ui_negative_profile_identity_changed");
        VerifyOriginalMaterial(entry,profile);
        ResidentWire.Need(ResidentWire.Bool(profile,"own_positive")&&ResidentWire.Bool(profile,"complete")&&ResidentWire.Bool(profile,"pass")&&ResidentWire.Bool(profile,"review_eligible")&&ResidentWire.Bool(profile,"objective_eligible")&&!ResidentWire.Bool(profile,"user_revoked")&&!ResidentWire.Bool(profile,"activation_frozen"),"ui_negative_objective_conditions_not_qualified");
        var negatives=profile["negatives"] as object[];ResidentWire.Need(negatives!=null&&negatives.Length<=512,"ui_negative_rows_invalid");var required=new Dictionary<string,Dictionary<string,object>>();bool ownSource=false;
        foreach(object raw in corpus){var item=ResidentWire.Map(raw);if(!ResidentWire.Same(item["scope"],entry.Scope))continue;var frame=ResidentWire.Map(item["frame"]);var capture=ResidentWire.Map(frame["capture"]);string captureSha=ResidentWire.Text(capture,"sha256"),state=ResidentWire.Text(item,"state_id");ResidentWire.Need(IsSha(captureSha),"ui_negative_capture_invalid");
            if(state==entry.State){if(captureSha==entry.SourceCaptureSha)ownSource=true;continue;}entry.RequiredStates.Add(state);string key=state+"\n"+captureSha;ResidentWire.Need(!required.ContainsKey(key),"ui_negative_corpus_duplicate");required.Add(key,capture);
        }
        ResidentWire.Need(ownSource&&required.Count>=1&&negatives.Length==required.Count,"ui_negative_corpus_incomplete");
        var seen=new HashSet<string>();foreach(object raw in negatives){var item=ResidentWire.Map(raw);string key=ResidentWire.Text(item,"state_id")+"\n"+ResidentWire.Text(item,"capture_sha256");ResidentWire.Need(required.ContainsKey(key)&&seen.Add(key)&&ResidentWire.Text(item,"capture_path")==ResidentWire.Text(required[key],"path")&&!ResidentWire.Bool(item,"matched")&&ResidentWire.Bool(item,"pass"),"ui_negative_row_failed_or_repeated");}
        ResidentWire.Need(entry.ModalGuard!=null,"ui_modal_guard_unsupported");entry.ActiveQualified=true;entry.EligibilityReason="objective_history_and_all_known_negatives";
    }
    static bool SameValue(object a,object b){
        if(a==null||b==null)return a==null&&b==null;
        var am=a as Dictionary<string,object>;var bm=b as Dictionary<string,object>;if(am!=null||bm!=null)return am!=null&&bm!=null&&am.Count==bm.Count&&am.All(p=>bm.ContainsKey(p.Key)&&SameValue(p.Value,bm[p.Key]));
        var aa=a as IList<object>;var ba=b as IList<object>;if(aa!=null||ba!=null){if(aa==null||ba==null||aa.Count!=ba.Count)return false;for(int i=0;i<aa.Count;i++)if(!SameValue(aa[i],ba[i]))return false;return true;}
        bool an=a is int||a is long||a is decimal||a is double,bn=b is int||b is long||b is decimal||b is double;if(an||bn)return an&&bn&&Convert.ToDouble(a)==Convert.ToDouble(b);return a.Equals(b);
    }
    static void VerifyPartMaterial(Dictionary<string,object> original,Dictionary<string,object> current){
        foreach(string field in new[]{"bbox","template_width","template_height","rgb_base64","template_sha256","max_mean_abs_error","max_fraction_above_24","source_capture_sha256"})ResidentWire.Need(original.ContainsKey(field)&&current.ContainsKey(field)&&SameValue(original[field],current[field]),"ui_compact_matcher_material_changed:"+field);
        foreach(string field in new[]{"crop_sha256","source_frame_id"})if(original.ContainsKey(field))ResidentWire.Need(current.ContainsKey(field)&&SameValue(original[field],current[field]),"ui_compact_source_material_changed:"+field);
    }
    static void VerifyOriginalMaterial(Entry entry,Dictionary<string,object> profile){
        string skillText=ResidentWire.Text(profile,"source_skill_canonical"),skillSha=ResidentWire.Text(profile,"source_skill_sha256"),signatureText=ResidentWire.Text(profile,"signature_original_canonical");
        ResidentWire.Need(skillText.Length<=262144&&signatureText.Length<=262144&&IsSha(skillSha)&&ResidentWire.Hash(Encoding.UTF8.GetBytes(skillText))==skillSha&&ResidentWire.Hash(Encoding.UTF8.GetBytes(signatureText))==entry.SignatureSha,"ui_original_material_sha_changed");
        var skill=ResidentWire.Map(ResidentWire.Decode(skillText));var signature=ResidentWire.Map(ResidentWire.Decode(signatureText));var rowSig=ResidentWire.Map(skill["signature"]);
        ResidentWire.Need(ResidentWire.Text(skill,"skill_id")==entry.Id&&ResidentWire.Text(skill,"state_id")==entry.State&&ResidentWire.Text(skill,"status")==entry.Status&&SameValue(skill["scope"],entry.Scope)&&ResidentWire.Bool(skill,"hard_stop")==entry.HardStop&&ResidentWire.Text(rowSig,"sha256")==entry.SignatureSha&&ResidentWire.Text(rowSig,"signature_id")==entry.Signature&&entry.Signature=="ui-signature-"+entry.SignatureSha.Substring(0,24),"ui_original_skill_identity_changed");
        ResidentWire.Need(SameValue(skill["element"],entry.Element)&&SameValue(skill.ContainsKey("action")?skill["action"]:null,entry.Action),"ui_compact_action_material_changed");
        ResidentWire.Need(SameValue(skill["review"],entry.AuthorityReview)&&ResidentWire.Text(ResidentWire.Map(skill["review"]),"status")!="rejected","ui_compact_source_adoption_changed_or_rejected");
        var governance=ResidentWire.Map(skill["governance"]);var metrics=ResidentWire.Map(governance["metrics"]);ResidentWire.Need(!ResidentWire.Bool(governance,"activation_frozen")&&ResidentWire.Bool(governance,"review_eligible")&&ResidentWire.Bool(governance,"objective_eligible")&&!ResidentWire.Bool(governance,"user_revoked")&&ResidentWire.Bool(metrics,"ready")&&ResidentWire.Int(metrics,"qualified_count")>=2&&ResidentWire.Int(metrics,"distinct_runs")>=2&&ResidentWire.Int(metrics,"recent_count")>=2&&ResidentWire.Num(metrics,"recent_success_rate")>=.8&&ResidentWire.Num(metrics,"recent_success_rate")<=1,"ui_objective_history_not_qualified");
        ResidentWire.Need(SameValue(profile["metrics"],metrics),"ui_objective_history_sidecar_changed");
        ResidentWire.Need(skill.ContainsKey("modal_guard")&&SameValue(skill["modal_guard"],entry.ModalGuard),"ui_compact_guard_material_changed");
        VerifyPartMaterial(signature,entry.RawSignature);VerifyPartMaterial(signature,rowSig);
        var originals=signature["anchors"] as object[];var current=entry.RawSignature["anchors"] as object[];var exported=rowSig["anchors"] as object[];ResidentWire.Need(originals!=null&&current!=null&&exported!=null&&originals.Length==current.Length&&originals.Length==exported.Length,"ui_compact_anchor_count_changed");
        for(int i=0;i<originals.Length;i++){VerifyPartMaterial(ResidentWire.Map(originals[i]),ResidentWire.Map(current[i]));VerifyPartMaterial(ResidentWire.Map(originals[i]),ResidentWire.Map(exported[i]));}
    }
    public void VerifyReflex(Dictionary<string,object> binding,Dictionary<string,object> current,Dictionary<string,object> action,Dictionary<string,object> frame){
        ResidentWire.Need(binding.Count==3&&ResidentWire.Text(binding,"route")=="reflex"&&ResidentWire.Text(binding,"knowledge_sha256")==KnowledgeSha,"ui_reflex_binding_changed");
        ResidentWire.Need(ResidentWire.Text(current,"status")=="known"&&!ResidentWire.Bool(current,"hard_stop")&&ResidentWire.Text(ResidentWire.Map(current["modal"]),"status")=="clear"&&ResidentWire.Text(current,"knowledge_sha256")==KnowledgeSha&&ResidentWire.Text(current,"confidence_basis")=="match_margin_v1","ui_reflex_current_scene_unsafe");
        var margin=ResidentWire.Map(current["match_margin"]);ResidentWire.Need(ResidentWire.Num(margin,"acceptance_threshold")==1&&ResidentWire.Num(margin,"positive_distance")>=0&&ResidentWire.Num(margin,"positive_distance")<1&&margin["next_state_distance"]!=null&&ResidentWire.Num(margin,"next_state_distance")>1&&ResidentWire.Num(margin,"next_state_distance")-ResidentWire.Num(margin,"positive_distance")>=.05,"ui_reflex_current_margin_ambiguous");
        string id=ResidentWire.Text(binding,"skill_id");var entry=entries.SingleOrDefault(e=>e.Id==id);ResidentWire.Need(entry!=null&&entry.ActiveQualified&&entry.State==ResidentWire.Text(current,"state_id"),"ui_reflex_not_qualified");
        var matches=current["matches"] as IList<object>;ResidentWire.Need(matches!=null&&matches.Any(row=>ResidentWire.Text(ResidentWire.Map(row),"skill_id")==id&&ResidentWire.Bool(ResidentWire.Map(row),"active_qualified")),"ui_reflex_current_match_missing");
        // Reflection must reproduce the reviewed primitive, not merely a
        // different finite action against the same authenticated window.
        ResidentWire.Need(ResidentWire.Text(action,"kind")=="timeline","ui_reflex_action_not_timeline");var events=action["events"] as object[];ResidentWire.Need(events!=null,"ui_reflex_events_missing");
        if(entry.Action!=null){
            ResidentWire.Need(ResidentWire.Text(entry.Action,"kind")=="key","ui_reflex_non_input_primitive");var keys=entry.Action["keys"] as object[];ResidentWire.Need(keys!=null&&keys.Length==1&&(String.Equals(keys[0],"ESC")||String.Equals(keys[0],"ENTER")),"ui_reflex_key_unsupported");
            int duration=ExactInteger(entry.Action,"duration_ms",1,150);ResidentWire.Need(events.Length==2&&ResidentWire.Int(action,"duration_ms")==duration,"ui_reflex_key_duration_changed");
            var down=ResidentWire.Map(events[0]);var up=ResidentWire.Map(events[1]);ResidentWire.Need(ResidentWire.Text(down,"kind")=="key_down"&&ResidentWire.Int(down,"at_ms")==0&&ResidentWire.Text(down,"key")==String.Concat(keys[0])&&ResidentWire.Text(up,"kind")=="key_up"&&ResidentWire.Int(up,"at_ms")==duration&&ResidentWire.Text(up,"key")==String.Concat(keys[0]),"ui_reflex_key_changed");
        }else{
            ResidentWire.Need(entry.Element!=null&&ResidentWire.Text(entry.Element,"purpose")!="npc_interact"&&events.Length==3,"ui_reflex_mouse_element_missing");var box=ResidentWire.Map(entry.Element["bbox"]);RectangleFor(box,ResidentWire.Int(frame,"client_width"),ResidentWire.Int(frame,"client_height"));
            int x=(int)Math.Floor((ResidentWire.Num(box,"x")+ResidentWire.Num(box,"width")/2)*ResidentWire.Int(frame,"client_width")),y=(int)Math.Floor((ResidentWire.Num(box,"y")+ResidentWire.Num(box,"height")/2)*ResidentWire.Int(frame,"client_height"));
            int duration=Math.Max(80,ExactInteger(entry.Element,"duration_ms",1,150));string button=ResidentWire.Text(entry.Element,"button");ResidentWire.Need(button=="left"||button=="right","ui_reflex_mouse_button_invalid");
            var move=ResidentWire.Map(events[0]);var down=ResidentWire.Map(events[1]);var up=ResidentWire.Map(events[2]);ResidentWire.Need(ResidentWire.Int(action,"duration_ms")==150+duration&&ResidentWire.Text(move,"kind")=="absolute_mouse_move"&&ResidentWire.Int(move,"at_ms")==0&&ResidentWire.Int(move,"x")==x&&ResidentWire.Int(move,"y")==y&&ResidentWire.Text(down,"kind")=="button_down"&&ResidentWire.Int(down,"at_ms")==150&&ResidentWire.Text(down,"button")==button&&ResidentWire.Text(up,"kind")=="button_up"&&ResidentWire.Int(up,"at_ms")==150+duration&&ResidentWire.Text(up,"button")==button,"ui_reflex_mouse_action_changed");
        }
    }
    public void VerifySlowSkill(Dictionary<string,object> binding,Dictionary<string,object> current){
        ResidentWire.Need(binding.Count==3&&ResidentWire.Text(binding,"route")=="slow_path"&&ResidentWire.Text(binding,"knowledge_sha256")==KnowledgeSha&&ResidentWire.Text(current,"status")=="known"&&!ResidentWire.Bool(current,"hard_stop"),"ui_slow_skill_current_binding_changed");
        var matches=current["matches"] as IList<object>;string id=ResidentWire.Text(binding,"skill_id");ResidentWire.Need(matches!=null&&matches.Count(row=>ResidentWire.Text(ResidentWire.Map(row),"skill_id")==id)==1,"ui_slow_skill_current_match_missing");
    }
    public static string AlgorithmSha(string metric){ResidentWire.Need(metric=="chroma_surface_v1"||metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3","ui_feature_metric_unknown");return ResidentWire.Hash(Encoding.UTF8.GetBytes(metric=="green_mask_v1"?GreenAlgorithm:metric=="green_glyph_tolerant_v2"?GreenTolerantAlgorithm:metric=="green_glyph_tolerant_v3"?GreenTolerantV3Algorithm:ChromaAlgorithm));}
    static void Feature(Entry entry,Dictionary<string,object> part,bool anchor,bool enabled){
        if(!part.ContainsKey("metric"))return;string metric=ResidentWire.Text(part,"metric");
        ResidentWire.Need(metric=="rgb_exact_v1"||metric=="chroma_surface_v1"||metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3","ui_feature_metric_unknown");if(metric=="rgb_exact_v1")return;
        ResidentWire.Need(enabled&&ResidentWire.Text(entry.Scope,"target_scope")=="retail_wow"&&(anchor||entry.State=="tutorial_talk_jaina"),"ui_feature_not_reviewed_talk_scope");
        ResidentWire.Need(anchor?(metric=="green_mask_v1"||metric=="green_glyph_tolerant_v2"||metric=="green_glyph_tolerant_v3"):metric=="chroma_surface_v1","ui_feature_part_rejected");
        entry.Metric=metric;entry.Algorithm=ResidentWire.Text(part,"algorithm_sha256");ResidentWire.Need(entry.Algorithm==AlgorithmSha(metric),"ui_feature_algorithm_sha_changed");
        if(metric=="chroma_surface_v1"){
            ResidentWire.Need(entry.Width==32&&entry.Height==16,"ui_chroma_reference_dimensions");
            double variance;Chroma(entry.Template,out variance);ResidentWire.Need(variance>=300,"ui_chroma_reference_variance_low");
        }else{
            var mask=ResidentWire.Map(part["mask"]);ResidentWire.Need(mask.Count==5&&ResidentWire.Text(mask,"packing")=="msb0-row-major","ui_green_mask_shape");
            entry.MaskWidth=MaskDimension(mask,"width",1024);entry.MaskHeight=MaskDimension(mask,"height",256);
            string text=ResidentWire.Text(mask,"base64");ResidentWire.Need(text.Length<=43692,"ui_green_mask_data_too_large");entry.Mask=Convert.FromBase64String(text);
            ResidentWire.Need(ResidentWire.Hash(entry.Mask)==ResidentWire.Text(mask,"sha256"),"ui_green_mask_sha_changed");
            ValidateMask(entry.Mask,entry.MaskWidth,entry.MaskHeight);
        }
    }
    static int MaskDimension(Dictionary<string,object> mask,string name,int maximum){
        return ExactInteger(mask,name,1,maximum);
    }
    static int ExactInteger(Dictionary<string,object> fields,string name,int minimum,int maximum){
        object raw=ResidentWire.Field(fields,name);ResidentWire.Need(raw is int||raw is long||raw is double||raw is decimal,"ui_reference_integer_type");
        double number=ResidentWire.Num(fields,name);ResidentWire.Need(number>=minimum&&number<=maximum&&number==Math.Floor(number),"ui_reference_integer_bounds");return(int)number;
    }
    // The immutable Python crop is authoritative. A decimal JSON round-trip
    // can move an exact boundary across floor/ceil by one ULP; do not resize
    // its mask or silently change historical normalized-only crop semantics.
    public static Rectangle ReferenceRectangle(Dictionary<string,object> box,Dictionary<string,object> reference,int width,int height){
        ResidentWire.Need(reference.Count==6,"ui_source_rect_shape");
        int rw=ExactInteger(reference,"client_width",1,16384),rh=ExactInteger(reference,"client_height",1,16384);
        ResidentWire.Need(rw==width&&rh==height,"ui_source_rect_client_changed");
        int x=ExactInteger(reference,"x",0,width-1),y=ExactInteger(reference,"y",0,height-1),w=ExactInteger(reference,"width",1,width),h=ExactInteger(reference,"height",1,height);
        ResidentWire.Need(x+w<=width&&y+h<=height,"ui_source_rect_outside_client");
        RectangleFor(box,width,height);double left=ResidentWire.Num(box,"x")*width,top=ResidentWire.Num(box,"y")*height,right=(ResidentWire.Num(box,"x")+ResidentWire.Num(box,"width"))*width,bottom=(ResidentWire.Num(box,"y")+ResidentWire.Num(box,"height"))*height;const double eps=1e-7;
        ResidentWire.Need(x>=Math.Floor(left-eps)&&x<=Math.Floor(left+eps)&&y>=Math.Floor(top-eps)&&y<=Math.Floor(top+eps)&&x+w>=Math.Ceiling(right-eps)&&x+w<=Math.Ceiling(right+eps)&&y+h>=Math.Ceiling(bottom-eps)&&y+h<=Math.Ceiling(bottom+eps),"ui_source_rect_not_normalized_crop");
        return new Rectangle(x,y,w,h);
    }
    static void Reference(Entry entry,Dictionary<string,object> part){
        if(!part.ContainsKey("source_rect"))return;var reference=ResidentWire.Map(part["source_rect"]);
        int width=ExactInteger(reference,"client_width",1,16384),height=ExactInteger(reference,"client_height",1,16384);
        ResidentWire.Need(ResidentWire.Text(entry.Scope,"size_bucket")==width+"x"+height,"ui_source_rect_scope_changed");
        entry.ReferenceRect=ReferenceRectangle(entry.Box,reference,width,height);entry.ReferenceWidth=width;entry.ReferenceHeight=height;
        if(entry.Mask!=null)ResidentWire.Need(entry.ReferenceRect.Value.Width==entry.MaskWidth&&entry.ReferenceRect.Value.Height==entry.MaskHeight,"ui_source_rect_mask_dimensions");
    }
    static Rectangle RegionRectangle(Entry entry,int width,int height){
        if(!entry.ReferenceRect.HasValue)return RectangleFor(entry.Box,width,height);
        ResidentWire.Need(width==entry.ReferenceWidth&&height==entry.ReferenceHeight,"ui_source_rect_client_changed");return entry.ReferenceRect.Value;
    }
    static int[] ValidateMask(byte[] mask,int width,int height){
        ResidentWire.Need(width>=1&&width<=1024&&height>=1&&height<=256&&mask!=null,"ui_green_mask_dimensions");int n=width*height;
        ResidentWire.Need(mask.Length==(n+7)/8,"ui_green_mask_length");int remainder=n%8;
        ResidentWire.Need(remainder==0||(mask[mask.Length-1]&((1<<(8-remainder))-1))==0,"ui_green_mask_padding");
        var points=new List<int>();for(int i=0;i<n;i++)if((mask[i/8]&(1<<(7-i%8)))!=0)points.Add(i);
        ResidentWire.Need(points.Count>=100,"ui_green_mask_foreground_low");return points.ToArray();
    }
    static byte[] CellRgb(byte[] bgra,int width,int height){
        ResidentWire.Need(width>=1&&width<=1024&&height>=1&&height<=1024&&(long)width*height<=262144&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_feature_pixels_shape");
        var rgb=new byte[32*16*3];for(int y=0;y<16;y++)for(int x=0;x<32;x++){
            int px=Math.Min(width-1,(int)((x+.5)*width/32)),py=Math.Min(height-1,(int)((y+.5)*height/16));int p=(py*width+px)*4,t=(y*32+x)*3;
            rgb[t]=bgra[p+2];rgb[t+1]=bgra[p+1];rgb[t+2]=bgra[p];
        }return rgb;
    }
    static double[] Chroma(byte[] rgb,out double variance){
        ResidentWire.Need(rgb!=null&&rgb.Length==32*16*3,"ui_chroma_reference_dimensions");var hist=new double[512];double sumLuma=0,sumSquares=0;
        for(int i=0;i<rgb.Length;i+=3){int r=rgb[i],g=rgb[i+1],b=rgb[i+2],sum=r+g+b;
            int rb=sum==0?0:Math.Min(7,r*8/sum),gb=sum==0?0:Math.Min(7,g*8/sum),bb=sum==0?0:Math.Min(7,b*8/sum);hist[rb*64+gb*8+bb]++;
            double luma=.299*r+.587*g+.114*b;sumLuma+=luma;sumSquares+=luma*luma;
        }
        for(int i=0;i<hist.Length;i++)hist[i]/=512;double mean=sumLuma/512;variance=Math.Max(0,sumSquares/512-mean*mean);return hist;
    }
    public static Dictionary<string,object> ScoreChroma(byte[] bgra,int width,int height,byte[] rgb){
        double sourceVariance,liveVariance;var source=Chroma(rgb,out sourceVariance);var live=Chroma(CellRgb(bgra,width,height),out liveVariance);double distance=0;
        for(int i=0;i<source.Length;i++)distance+=Math.Abs(source[i]-live[i]);distance*=.5;
        return ResidentWire.Obj("metric","chroma_surface_v1","algorithm_sha256",AlgorithmSha("chroma_surface_v1"),"matched",distance<=.15&&sourceVariance>=300&&liveVariance>=300,"tv_distance",distance,"max_tv_distance",.15,"source_luma_variance",sourceVariance,"live_luma_variance",liveVariance,"min_luma_variance",300);
    }
    public static Dictionary<string,object> ScoreGreenMask(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        int[] points=ValidateMask(reference,referenceWidth,referenceHeight);
        ResidentWire.Need(width==referenceWidth&&height==referenceHeight&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_green_live_dimensions_actual"+width+"x"+height+"_ref"+referenceWidth+"x"+referenceHeight);
        var live=new bool[width*height];int count=0;for(int i=0;i<live.Length;i++){int p=i*4,r=bgra[p+2],g=bgra[p+1],b=bgra[p];bool green=g>=60&&g*10>r*13&&g*10>b*13;live[i]=green;if(green)count++;}
        double best=0;int bestX=0,bestY=0;
        if(count>=100)for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++){
            int intersection=0;foreach(int p in points){int x=p%width+dx,y=p/width+dy;if(x>=0&&y>=0&&x<width&&y<height&&live[y*width+x])intersection++;}
            double iou=(double)intersection/(points.Length+count-intersection);if(iou>best){best=iou;bestX=dx;bestY=dy;}
        }
        return ResidentWire.Obj("metric","green_mask_v1","algorithm_sha256",AlgorithmSha("green_mask_v1"),"matched",count>=100&&best>=.9,"mask_iou",best,"min_iou",.9,"source_foreground",points.Length,"live_foreground",count,"min_foreground",100,"shift_x",bestX,"shift_y",bestY,"max_shift",3);
    }
    static bool[] DilateGlyph(bool[] mask,int width,int height){
        var dilated=new bool[mask.Length];for(int p=0;p<mask.Length;p++)if(mask[p]){
            int x=p%width,y=p/width;for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){
                int nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<width&&ny<height)dilated[ny*width+nx]=true;
            }
        }return dilated;
    }
    public static Dictionary<string,object> ScoreGreenGlyphTolerant(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        return ScoreGreenGlyph(bgra,width,height,reference,referenceWidth,referenceHeight,.65,"green_glyph_tolerant_v2");
    }
    public static Dictionary<string,object> ScoreGreenGlyphTolerantV3(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight){
        return ScoreGreenGlyph(bgra,width,height,reference,referenceWidth,referenceHeight,.5,"green_glyph_tolerant_v3");
    }
    static Dictionary<string,object> ScoreGreenGlyph(byte[] bgra,int width,int height,byte[] reference,int referenceWidth,int referenceHeight,double minRaw,string metric){
        int[] points=ValidateMask(reference,referenceWidth,referenceHeight);
        ResidentWire.Need(width==referenceWidth&&height==referenceHeight&&bgra!=null&&(long)bgra.Length==(long)width*height*4,"ui_green_live_dimensions_actual"+width+"x"+height+"_ref"+referenceWidth+"x"+referenceHeight);
        var source=new bool[width*height];foreach(int p in points)source[p]=true;
        var live=new bool[source.Length];var livePoints=new List<int>();for(int i=0;i<live.Length;i++){
            int p=i*4,r=bgra[p+2],g=bgra[p+1],b=bgra[p];live[i]=g>=60&&g*10>r*13&&g*10>b*13;if(live[i])livePoints.Add(i);
        }
        double ratio=(double)livePoints.Count/points.Length;bool eligible=livePoints.Count>=100&&ratio>=.8&&ratio<=1.25,matched=false;
        double bestCoverage=-1,bestIou=0,bestSourceCoverage=0,bestLiveCoverage=0;int bestX=0,bestY=0;
        if(eligible){
            var sourceDilated=DilateGlyph(source,width,height);var liveDilated=DilateGlyph(live,width,height);
            for(int dy=-3;dy<=3;dy++)for(int dx=-3;dx<=3;dx++){
                int intersection=0,sourceCovered=0,liveCovered=0;
                foreach(int p in points){int x=p%width+dx,y=p/width+dy;if(x>=0&&y>=0&&x<width&&y<height){int q=y*width+x;if(live[q])intersection++;if(liveDilated[q])sourceCovered++;}}
                foreach(int p in livePoints){int x=p%width-dx,y=p/width-dy;if(x>=0&&y>=0&&x<width&&y<height&&sourceDilated[y*width+x])liveCovered++;}
                // Counts use the full original masks. Clipping at a shifted
                // ROI boundary never reduces the denominators or grants coverage.
                double iou=(double)intersection/(points.Length+livePoints.Count-intersection),sourceCoverage=(double)sourceCovered/points.Length,liveCoverage=(double)liveCovered/livePoints.Count,coverage=Math.Min(sourceCoverage,liveCoverage);
                bool passed=iou>=minRaw&&coverage>=.95;
                if(passed&&!matched||passed==matched&&(coverage>bestCoverage||coverage==bestCoverage&&iou>bestIou)){
                    matched=passed;bestCoverage=coverage;bestIou=iou;bestSourceCoverage=sourceCoverage;bestLiveCoverage=liveCoverage;bestX=dx;bestY=dy;
                }
            }
        }
        return ResidentWire.Obj("metric",metric,"algorithm_sha256",AlgorithmSha(metric),"matched",matched,"raw_iou",bestIou,"min_raw_iou",minRaw,"source_coverage",bestSourceCoverage,"live_coverage",bestLiveCoverage,"bidirectional_coverage",Math.Max(0,bestCoverage),"min_bidirectional_coverage",.95,"foreground_ratio",ratio,"min_foreground_ratio",.8,"max_foreground_ratio",1.25,"source_foreground",points.Length,"live_foreground",livePoints.Count,"min_foreground",100,"dilation_radius",1,"shift_x",bestX,"shift_y",bestY,"max_shift",3);
    }
    static Dictionary<string,object> EntryScore(Entry entry,WgcCapture.Roi roi){
        if(entry.Metric=="chroma_surface_v1")return ScoreChroma(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Template);
        if(entry.Metric=="green_mask_v1")return ScoreGreenMask(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        if(entry.Metric=="green_glyph_tolerant_v2")return ScoreGreenGlyphTolerant(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        if(entry.Metric=="green_glyph_tolerant_v3")return ScoreGreenGlyphTolerantV3(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Mask,entry.MaskWidth,entry.MaskHeight);
        return Score(roi.Pixels,roi.Rectangle.Width,roi.Rectangle.Height,entry.Template,entry.Width,entry.Height,entry.MaxError,entry.MaxFraction);
    }
    static byte[] CropPixels(byte[] pixels,int width,int height,Rectangle rect){
        ResidentWire.Need(rect.Left>=0&&rect.Top>=0&&rect.Width>0&&rect.Height>0&&rect.Right<=width&&rect.Bottom<=height,"npc_current_crop_bounds");
        var crop=new byte[rect.Width*rect.Height*4];for(int y=0;y<rect.Height;y++)Buffer.BlockCopy(pixels,((rect.Y+y)*width+rect.X)*4,crop,y*rect.Width*4,rect.Width*4);return crop;
    }
    /** Locates the reference glyph in the CURRENT pixels, then derives a body
     * interior from its yellow contour. No reference click point is accepted. */
    public static Dictionary<string,object> LocateNpc(byte[] pixels,int width,int height,byte[] nameMask,int maskWidth,int maskHeight,string name){
        ResidentWire.Need(width>=1&&width<=7680&&height>=1&&height<=4320&&pixels!=null&&(long)pixels.Length==(long)width*height*4,"npc_current_pixels_shape");
        ResidentWire.Need(!String.IsNullOrWhiteSpace(name)&&name.Length<=200,"npc_current_name_missing");
        int[] reference=ValidateMask(nameMask,maskWidth,maskHeight);int minX=maskWidth,minY=maskHeight,maxX=0,maxY=0;
        foreach(int p in reference){int x=p%maskWidth,y=p/maskWidth;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);}
        var rowCounts=new int[height];var green=new bool[width*height];for(int p=0;p<green.Length;p++){int b=p*4,r=pixels[b+2],g=pixels[b+1],bl=pixels[b];if(g>=60&&g*10>r*13&&g*10>bl*13){green[p]=true;rowCounts[p/width]++;}}
        var refColumns=new bool[maskWidth];foreach(int p in reference)refColumns[p%maskWidth]=true;int maxColumnGap=0,columnGap=0;for(int x=minX;x<=maxX;x++){if(refColumns[x]){maxColumnGap=Math.Max(maxColumnGap,columnGap);columnGap=0;}else columnGap++;}
        int joinGap=Math.Min(64,Math.Max(10,maxColumnGap+4));
        var found=new List<Dictionary<string,object>>();var rects=new List<Rectangle>();var attempts=new List<object>();int rowThreshold=Math.Max(4,reference.Length/Math.Max(1,maxY-minY+1)/5);
        var referenceRows=new int[maskHeight];foreach(int p in reference)referenceRows[p/maskWidth]++;
        // Both origins use the same significant-row rule. A few green sea
        // pixels above the lettering must not become the template origin.
        int referenceTextTop=0;while(referenceTextTop<maskHeight&&referenceRows[referenceTextTop]<rowThreshold)referenceTextTop++;
        ResidentWire.Need(referenceTextTop<maskHeight,"npc_reference_glyph_rows_missing");
        for(int top=0;top<height;top++){
            if(rowCounts[top]<rowThreshold)continue;int bottom=top,last=top,gap=0;
            while(bottom+1<height&&gap<3){bottom++;if(rowCounts[bottom]>=rowThreshold){last=bottom;gap=0;}else gap++;}
            bottom=last;if(bottom-top+1>maskHeight+6){top=bottom;continue;}
            var columns=new int[width];for(int y=top;y<=bottom;y++)for(int x=0;x<width;x++)if(green[y*width+x])columns[x]++;
            for(int left=0;left<width;left++){
                if(columns[left]==0)continue;int right=left,end=left,cgap=0,count=0;
                while(right+1<width&&cgap<joinGap){right++;if(columns[right]>0){end=right;cgap=0;}else cgap++;}
                right=end;for(int x=left;x<=right;x++)count+=columns[x];int span=right-left+1,refSpan=maxX-minX+1;
                if(count>=100&&span>=refSpan*.85&&span<=refSpan*1.15){
                    var canvas=new Rectangle(left-minX,top-referenceTextTop,maskWidth,maskHeight);
                    if(canvas.Left>=0&&canvas.Top>=0&&canvas.Right<=width&&canvas.Bottom<=height){
                        var score=ScoreGreenGlyphTolerantV3(CropPixels(pixels,width,height,canvas),maskWidth,maskHeight,nameMask,maskWidth,maskHeight);
                        if(attempts.Count<16)attempts.Add(ResidentWire.Obj("rect",Rect(canvas),"score",score));
                        if(ResidentWire.Bool(score,"matched")){rects.Add(canvas);found.Add(score);}
                    }
                }left=right;
            }top=bottom;
        }
        if(found.Count!=1)return ResidentWire.Obj("status","unknown","reason",found.Count==0?"current_nameplate_not_found":"current_nameplate_ambiguous","candidates",found.Count,"proposals",attempts,"method","current_nameplate_yellow_outline_v1");
        Rectangle plate=rects[0];var body=YellowBody(pixels,width,height,plate);
        if(body==null)return ResidentWire.Obj("status","unknown","reason","current_yellow_body_not_unique_or_enclosed","nameplate_rect",Rect(plate),"name_score",found[0],"method","current_nameplate_yellow_outline_v1");
        body["status"]="known";body["name"]=name;body["nameplate_rect"]=Rect(plate);body["name_score"]=found[0];body["method"]="current_nameplate_yellow_outline_v1";return body;
    }
    static Dictionary<string,object> Rect(Rectangle rect){return ResidentWire.Obj("x",rect.X,"y",rect.Y,"width",rect.Width,"height",rect.Height);}
    static Dictionary<string,object> YellowBody(byte[] pixels,int width,int height,Rectangle plate){
        int left=Math.Max(0,plate.Left-plate.Width/2),right=Math.Min(width,plate.Right+plate.Width/2),top=plate.Bottom,bottom=Math.Min(height,plate.Bottom+plate.Height*14);
        if(bottom<=top)return null;int w=right-left,h=bottom-top;var yellow=new bool[w*h];
        for(int y=0;y<h;y++)for(int x=0;x<w;x++){int p=((top+y)*width+left+x)*4,r=pixels[p+2],g=pixels[p+1],b=pixels[p];yellow[y*w+x]=r>=180&&g>=160&&b<=100&&r*2>b*3&&g*2>b*3;}
        var connected=DilateGlyph(yellow,w,h);var visited=new bool[connected.Length];var candidates=new List<Rectangle>();
        for(int p=0;p<connected.Length;p++)if(connected[p]&&!visited[p]){
            var queue=new Queue<int>();queue.Enqueue(p);visited[p]=true;int minX=w,minY=h,maxX=0,maxY=0,count=0;
            while(queue.Count>0){int at=queue.Dequeue(),x=at%w,y=at/w;count++;minX=Math.Min(minX,x);minY=Math.Min(minY,y);maxX=Math.Max(maxX,x);maxY=Math.Max(maxY,y);
                for(int dy=-1;dy<=1;dy++)for(int dx=-1;dx<=1;dx++){int nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<w&&ny<h){int q=ny*w+nx;if(connected[q]&&!visited[q]){visited[q]=true;queue.Enqueue(q);}}}
            }
            var rect=new Rectangle(left+minX,top+minY,maxX-minX+1,maxY-minY+1);
            if(count>=100&&rect.Width>=plate.Width*.15&&rect.Width<=plate.Width*1.2&&rect.Height>=plate.Height*3&&rect.Bottom>=plate.Bottom+plate.Height*5)candidates.Add(rect);
        }
        // The two outline sides need not be pixel-connected: clothing and
        // weapon contours can be separated by the body interior. Merge only
        // components whose body-height bands substantially overlap and whose
        // horizontal bounds overlap or nearly touch under this nameplate.
        for(int i=0;i<candidates.Count;i++)for(int j=i+1;j<candidates.Count;j++){
            Rectangle a=candidates[i],b=candidates[j];int overlap=Math.Min(a.Bottom,b.Bottom)-Math.Max(a.Top,b.Top);
            int separation=Math.Max(0,Math.Max(a.Left,b.Left)-Math.Min(a.Right,b.Right));
            Rectangle union=Rectangle.Union(a,b);
            if(overlap>=Math.Min(a.Height,b.Height)*.7&&separation<=plate.Width*.15&&union.Width<=plate.Width*1.2){candidates[i]=union;candidates.RemoveAt(j);j=i;}
        }
        if(candidates.Count!=1)return null;Rectangle bounds=candidates[0];int desired=bounds.Top+35*bounds.Height/100;
        for(int offset=0;offset<=bounds.Height/12;offset++)for(int direction=0;direction<(offset==0?1:2);direction++){
            int y=desired+(direction==0?offset:-offset);if(y<top+3||y>=bottom-3)continue;int x0=width,x1=-1;
            for(int x=bounds.Left;x<bounds.Right;x++)if(yellow[(y-top)*w+x-left]){x0=Math.Min(x0,x);x1=Math.Max(x1,x);}
            int span=x1-x0;if(span<plate.Width*.15||span>plate.Width*.7)continue;int px=(x0+x1)/2;bool interior=true;
            for(int dy=-2;dy<=2;dy++)for(int dx=-2;dx<=2;dx++)if(yellow[(y+dy-top)*w+px+dx-left])interior=false;
            if(interior)return ResidentWire.Obj("body_point",ResidentWire.Obj("x",px,"y",y),"body_rect",Rect(bounds),"interior_span",span,"point_semantics","detected_body_interior");
        }return null;
    }
    public static Rectangle RectangleFor(Dictionary<string,object> box,int width,int height) {
        double x=ResidentWire.Num(box,"x"),y=ResidentWire.Num(box,"y"),w=ResidentWire.Num(box,"width"),h=ResidentWire.Num(box,"height");
        ResidentWire.Need(x>=0&&y>=0&&w>0&&h>0&&x+w<=1&&y+h<=1,"ui_normalized_bbox_invalid");
        int left=(int)Math.Floor(x*width),top=(int)Math.Floor(y*height),right=(int)Math.Ceiling((x+w)*width),bottom=(int)Math.Ceiling((y+h)*height);
        ResidentWire.Need(right>left&&bottom>top&&right<=width&&bottom<=height,"ui_roi_invalid");return new Rectangle(left,top,right-left,bottom-top);
    }
    public List<RecoveryCvRegion> Regions(int width,int height,Dictionary<string,object> scope) {
        var result=new List<RecoveryCvRegion>();foreach(var e in entries)if(ResidentWire.Same(e.Scope,scope)){
            if(e.ModalGuard!=null&&!result.Any(r=>r.Id=="learned-ui-modal-current-view"))result.Add(new RecoveryCvRegion{Id="learned-ui-modal-current-view",Rectangle=new Rectangle(0,0,width,height)});
            if(e.NpcAnchor>=0){
                // One current in-memory ROI supplies both glyph search and
                // yellow contour. Never stage the old reference click patch.
                if(!result.Any(r=>r.Id=="learned-ui-npc-current-view"))result.Add(new RecoveryCvRegion{Id="learned-ui-npc-current-view",Rectangle=new Rectangle(0,0,width,height)});
                for(int a=0;a<e.Anchors.Count;a++)if(a!=e.NpcAnchor)result.Add(new RecoveryCvRegion{Id="learned-ui-"+e.Anchors[a].Id,Rectangle=RegionRectangle(e.Anchors[a],width,height)});
                continue;
            }
            result.Add(new RecoveryCvRegion{Id="learned-ui-"+e.Id,Rectangle=RegionRectangle(e,width,height)});
            foreach(var a in e.Anchors)result.Add(new RecoveryCvRegion{Id="learned-ui-"+a.Id,Rectangle=RegionRectangle(a,width,height)});
        }return result;
    }
    public static Dictionary<string,object> Score(byte[] bgra,int width,int height,byte[] rgb,int tw,int th,double maxError,double maxFraction) {
        ResidentWire.Need(bgra.Length==width*height*4&&rgb.Length==tw*th*3,"ui_pixels_shape");double sum=0;int over=0,n=rgb.Length;
        for(int y=0;y<th;y++)for(int x=0;x<tw;x++) {
            int px=Math.Min(width-1,(int)((x+.5)*width/tw)),py=Math.Min(height-1,(int)((y+.5)*height/th));int offset=(py*width+px)*4,t=(y*tw+x)*3;
            for(int c=0;c<3;c++){int error=Math.Abs(bgra[offset+2-c]-rgb[t+c]);sum+=error;if(error>24)over++;}
        }
        double mean=sum/n,fraction=(double)over/n;return ResidentWire.Obj("matched",mean<=maxError&&fraction<=maxFraction,"mean_abs_error",mean,"fraction_above_24",fraction);
    }
    public Dictionary<string,object> Match(IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> scope,Dictionary<string,object> frame=null) {
        double started=WowJev.Input.Clock.PreciseMs;var matches=new List<object>();var distances=new List<KeyValuePair<string,double>>();
        foreach(var e in entries) {
            if(e.NpcAnchor>=0&&ResidentWire.Same(e.Scope,scope)){
                var current=e.NpcMethod=="current_neutral_nameplate_v1"?DynamicNeutralMatch(e,rois,regions,frame):DynamicMatch(e,rois,regions,frame);if(current!=null){double distance=e.NpcMethod=="current_neutral_nameplate_v1"?ResidentWire.Num(current,"positive_distance"):CompositeDistance(e,ResidentWire.Map(current["scores"]));distances.Add(new KeyValuePair<string,double>(e.State,distance));current["positive_distance"]=distance;current["active_qualified"]=false;current["eligibility_reason"]="dynamic_feature_negative_validation_not_available";if(e.RecognizeApproved)matches.Add(current);}continue;
            }
            if(!ResidentWire.Same(e.Scope,scope))continue;int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+e.Id){index=i;break;}if(index<0)continue;
            var roi=rois[index];var score=EntryScore(e,roi);
            var anchorScores=new List<object>();bool anchorsMatched=true;
            foreach(var a in e.Anchors) {
                int ai=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+a.Id){ai=i;break;}
                if(ai<0){anchorsMatched=false;anchorScores.Add(null);continue;}var ar=rois[ai];var scored=EntryScore(a,ar);anchorsMatched&=ResidentWire.Bool(scored,"matched");scored["roi_sha256"]=ar.Hash;anchorScores.Add(scored);
            }
            score["anchors"]=anchorScores;
            double composite=CompositeDistance(e,score);distances.Add(new KeyValuePair<string,double>(e.State,composite));
            if(e.RecognizeApproved&&anchorsMatched&&ResidentWire.Bool(score,"matched"))matches.Add(ResidentWire.Obj("skill_id",e.Id,"state_id",e.State,"signature_id",e.Signature,"status",e.Status,"hard_stop",e.HardStop,"roi_sha256",roi.Hash,"scores",score,"positive_distance",composite,"active_qualified",e.ActiveQualified,"eligibility_reason",e.EligibilityReason));
        }
        var states=matches.Select(row=>ResidentWire.Text(ResidentWire.Map(row),"state_id")).Distinct().ToArray();bool known=states.Length==1;
        double best=matches.Count==0?1:matches.Min(row=>ResidentWire.Num(ResidentWire.Map(row),"positive_distance"));string state=known?states[0]:null;var competing=distances.Where(pair=>pair.Key!=state).Select(pair=>pair.Value).ToArray();double? next=competing.Length==0?(double?)null:competing.Min();
        double confidence=known?Math.Max(0,1-best)*(next.HasValue?Math.Min(1,Math.Max(0,next.Value-best)):1):0;bool stop=matches.Any(row=>ResidentWire.Bool(ResidentWire.Map(row),"hard_stop"));
        var modal=ModalForCurrent(matches,rois,regions,frame);bool clear=ResidentWire.Text(modal,"status")=="clear";bool reflex=known&&clear&&best<1&&next.HasValue&&next.Value>1&&next.Value-best>=.05&&matches.All(row=>ResidentWire.Bool(ResidentWire.Map(row),"active_qualified"));
        return ResidentWire.Obj("status",known?"known":"unknown","recognition_status",stop?"hard_stop":known?"known":"unknown","route_eligibility",stop?"hard_stop":reflex?"candidate":"slow_path","state_id",known?(object)states[0]:null,"confidence",confidence,"confidence_basis","match_margin_v1","match_margin",ResidentWire.Obj("positive_distance",best,"acceptance_threshold",1,"next_state_distance",next.HasValue?(object)next.Value:null),"modal",modal,"matches",matches,"knowledge_sha256",KnowledgeSha,"source_knowledge_sha256",SourceKnowledgeSha,"negative_validation_sha256",NegativeValidationSha,"hard_stop",stop,"quarantine",quarantine.ToArray(),"started_qpc_ms",started,"finished_qpc_ms",WowJev.Input.Clock.PreciseMs);
    }
    static double ErrorRatio(double value,double threshold){return threshold>0?Math.Min(100,value/threshold):value==0?0:100;}
    static double Distance(Entry entry,Dictionary<string,object> score){
        if(entry.Metric=="chroma_surface_v1")return Math.Max(ResidentWire.Num(score,"tv_distance")/.15,Math.Min(ResidentWire.Num(score,"source_luma_variance"),ResidentWire.Num(score,"live_luma_variance"))<300?2:0);
        if(entry.Metric=="green_mask_v1")return(1-ResidentWire.Num(score,"mask_iou"))/(1-.9);
        if(entry.Metric=="green_glyph_tolerant_v2"||entry.Metric=="green_glyph_tolerant_v3"){
            double ratio=ResidentWire.Num(score,"foreground_ratio");return Math.Max((1-ResidentWire.Num(score,"raw_iou"))/(1-ResidentWire.Num(score,"min_raw_iou")),Math.Max((1-ResidentWire.Num(score,"bidirectional_coverage"))/.05,ratio<1?(1-ratio)/.2:(ratio-1)/.25));
        }
        return Math.Max(ErrorRatio(ResidentWire.Num(score,"mean_abs_error"),entry.MaxError),ErrorRatio(ResidentWire.Num(score,"fraction_above_24"),entry.MaxFraction));
    }
    static double CompositeDistance(Entry entry,Dictionary<string,object> score){double distance=Distance(entry,score);var anchors=score["anchors"] as IList<object>;if(anchors==null)return 100;for(int i=0;i<entry.Anchors.Count;i++){if(i>=anchors.Count||anchors[i]==null)return 100;distance=Math.Max(distance,Distance(entry.Anchors[i],ResidentWire.Map(anchors[i])));}return Math.Min(100,Math.Max(0,distance));}
    Dictionary<string,object> ModalForCurrent(List<object> matches,IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> frame){
        if(frame==null||matches.Count==0)return ResidentWire.Obj("status","unknown","reason","current_scene_guard_unavailable","evidence",new object[0]);
        int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-modal-current-view"){index=i;break;}if(index<0)return ResidentWire.Obj("status","unknown","reason","modal_guard_unsupported","evidence",new object[0]);
        Dictionary<string,object> result=null;foreach(object row in matches){var match=ResidentWire.Map(row);var entry=entries.First(e=>e.Id==ResidentWire.Text(match,"skill_id"));if(entry.ModalGuard==null)return ResidentWire.Obj("status","unknown","reason","matched_scene_guard_unsupported","evidence",new object[0]);
            var actual=CheckModal(rois[index].Pixels,rois[index].Rectangle.Width,rois[index].Rectangle.Height,(object[])entry.ModalGuard["expected_panels"]);if(result!=null&&!ResidentWire.Same(result,actual))return ResidentWire.Obj("status","unknown","reason","scene_guards_disagree","evidence",new object[0]);result=actual;
        }
        result["evidence"]=new object[]{ResidentWire.Obj("kind","current_neutral_panel_scan","roi_id","learned-ui-modal-current-view","roi_sha256",rois[index].Hash,"calibration_sha256",KnowledgeSha,"frame_id",frame["frame_id"],"source_qpc_ms",frame["source_qpc_ms"],"layout_id",frame["layout_id"])};return result;
    }
    Dictionary<string,object> DynamicMatch(Entry entry,IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> frame){
        if(frame==null)return null;int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-npc-current-view"){index=i;break;}if(index<0)return null;
        var view=rois[index];int width=ResidentWire.Int(frame,"client_width"),height=ResidentWire.Int(frame,"client_height");ResidentWire.Need(view.Rectangle==new Rectangle(0,0,width,height),"ui_npc_current_view_partial");
        var anchor=entry.Anchors[entry.NpcAnchor];var located=LocateNpc(view.Pixels,width,height,anchor.Mask,anchor.MaskWidth,anchor.MaskHeight,entry.NpcName);if(ResidentWire.Text(located,"status")!="known")return null;
        var plate=ResidentWire.Map(located["nameplate_rect"]);Rectangle referencePlate=RegionRectangle(anchor,width,height),referenceBody=RegionRectangle(entry,width,height);
        int dx=ResidentWire.Int(plate,"x")-referencePlate.X,dy=ResidentWire.Int(plate,"y")-referencePlate.Y;var bodyCrop=new Rectangle(referenceBody.X+dx,referenceBody.Y+dy,referenceBody.Width,referenceBody.Height);
        if(bodyCrop.Left<0||bodyCrop.Top<0||bodyCrop.Right>width||bodyCrop.Bottom>height)return null;
        var crop=CropPixels(view.Pixels,width,height,bodyCrop);var score=ScoreChroma(crop,bodyCrop.Width,bodyCrop.Height,entry.Template);if(!ResidentWire.Bool(score,"matched"))return null;
        var scores=new List<object>();for(int a=0;a<entry.Anchors.Count;a++){
            if(a==entry.NpcAnchor){var glyph=ResidentWire.Map(located["name_score"]);glyph["roi_sha256"]=view.Hash;glyph["current_rect"]=plate;scores.Add(glyph);continue;}
            int ai=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+entry.Anchors[a].Id){ai=i;break;}if(ai<0)return null;
            var ar=rois[ai];var result=EntryScore(entry.Anchors[a],ar);if(!ResidentWire.Bool(result,"matched"))return null;result["roi_sha256"]=ar.Hash;scores.Add(result);
        }
        score["anchors"]=scores;score["current_body_crop"]=Rect(bodyCrop);score["current_body_crop_sha256"]=ResidentWire.Hash(crop);
        var location=ResidentWire.Obj("method","current_nameplate_yellow_outline_v1","name",entry.NpcName,"frame_id",frame["frame_id"],"source_qpc_ms",frame["source_qpc_ms"],"layout_id",frame["layout_id"],"roi_id","learned-ui-npc-current-view","roi_sha256",view.Hash,"calibration_sha256",KnowledgeSha,"nameplate_rect",plate,"score",located["name_score"],"point_semantics","detected_body_interior");
        return ResidentWire.Obj("skill_id",entry.Id,"state_id",entry.State,"signature_id",entry.Signature,"status",entry.Status,"hard_stop",entry.HardStop,"roi_sha256",view.Hash,"scores",score,"current_point",located["body_point"],"current_rect",located["body_rect"],"location",location);
    }
    Dictionary<string,object> DynamicNeutralMatch(Entry entry,IList<WgcCapture.Roi> rois,IList<RecoveryCvRegion> regions,Dictionary<string,object> frame){
        if(frame==null)return null;int index=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-npc-current-view"){index=i;break;}if(index<0)return null;
        var view=rois[index];int width=ResidentWire.Int(frame,"client_width"),height=ResidentWire.Int(frame,"client_height");ResidentWire.Need(view.Rectangle==new Rectangle(0,0,width,height),"ui_dummy_current_view_partial");
        if(entry.ReferenceWidth!=width||entry.ReferenceHeight!=height)return null;
        var name=entry.Anchors[entry.NpcAnchor];var reference=new TrainingDummyVision.Reference{Name=entry.NpcName,Width=width,Height=height,NameRect=name.ReferenceRect.Value,BodyRect=entry.ReferenceRect.Value,GoldRect=entry.NeutralGoldRect.Value,NameRgb=name.Template,BodyRgb=entry.Template,NameMask=entry.NeutralNameMask};
        var found=TrainingDummyVision.Locate(view.Pixels,width,height,reference);if(found.Count==0)return null;
        var hit=found[0];var anchorScores=new List<object>();double distance=Math.Max(hit.BodyScore.ChromaDistance/.15,Math.Max((1-hit.NameScore.RawIou)/.5,(1-hit.NameScore.Coverage)/.05));
        var glyph=ResidentWire.Obj("metric","neutral_nameplate_glyph_v1","matched",true,"raw_iou",hit.NameScore.RawIou,"bidirectional_coverage",hit.NameScore.Coverage,"foreground_ratio",hit.NameScore.ForegroundRatio,"roi_sha256",view.Hash,"current_rect",Rect(hit.NameRect));
        for(int a=0;a<entry.Anchors.Count;a++){
            if(a==entry.NpcAnchor){anchorScores.Add(glyph);continue;}int ai=-1;for(int i=0;i<regions.Count;i++)if(regions[i].Id=="learned-ui-"+entry.Anchors[a].Id){ai=i;break;}if(ai<0)return null;
            var score=EntryScore(entry.Anchors[a],rois[ai]);if(!ResidentWire.Bool(score,"matched"))return null;score["roi_sha256"]=rois[ai].Hash;anchorScores.Add(score);distance=Math.Max(distance,Distance(entry.Anchors[a],score));
        }
        var body=ResidentWire.Obj("metric","chroma_surface_v1","matched",true,"distance_tv",hit.BodyScore.ChromaDistance,"source_luma_variance",hit.BodyScore.SourceVariance,"live_luma_variance",hit.BodyScore.LiveVariance,"anchors",anchorScores,"current_body_crop",Rect(hit.BodyRect),"current_body_crop_sha256",ResidentWire.Hash(CropPixels(view.Pixels,width,height,hit.BodyRect)));
        var location=ResidentWire.Obj("method","current_neutral_nameplate_v1","name",entry.NpcName,"frame_id",frame["frame_id"],"source_qpc_ms",frame["source_qpc_ms"],"layout_id",frame["layout_id"],"roi_id","learned-ui-npc-current-view","roi_sha256",view.Hash,"calibration_sha256",KnowledgeSha,"nameplate_rect",Rect(hit.NameRect),"score",glyph,"point_semantics","detected_body_interior");
        return ResidentWire.Obj("skill_id",entry.Id,"state_id",entry.State,"signature_id",entry.Signature,"status",entry.Status,"hard_stop",entry.HardStop,"roi_sha256",view.Hash,"scores",body,"positive_distance",distance,"current_point",ResidentWire.Obj("x",hit.Point.X,"y",hit.Point.Y),"current_rect",Rect(hit.BodyRect),"location",location);
    }

}
