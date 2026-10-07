import type {RecoveryFrame,RecoveryInterpretation,RecoveryPointSafety} from './types.js';
export type FocusVisibilityMode='complete_client'|'visible_point';

/** Native point evidence belongs to this original observation and exact target. */
export function verifiedFocusCandidate(frame:RecoveryFrame,c:RecoveryPointSafety,allowRecent=false):boolean {
  const t=frame.observation.target,w=frame.observation.window,p=c?.point;
  if(!c||c.mode!=='visible_point'||c.owned_click_started!==false||!p||
    !Number.isSafeInteger(p.x)||!Number.isSafeInteger(p.y)||c.patch_radius!==2||
    ![Math.floor(frame.source.width*.6),Math.floor(frame.source.width*.75)].includes(p.x)||
    ![Math.floor(frame.source.height*.25),Math.floor(frame.source.height*.75)].includes(p.y)||
    p.x<2||p.y<2||p.x>=frame.source.width-2||p.y>=frame.source.height-2||
    c.pid!==t.pid||c.process_start_ticks!==t.start_ticks||typeof c.hwnd!=='string'||c.hwnd.toLowerCase()!==t.hwnd.toLowerCase()||
    c.class!==t.class||c.executable?.toLowerCase()!==t.executable.toLowerCase()||c.session_id!==1||c.probe_session_id!==1||
    c.client_width!==w.client_width||c.client_height!==w.client_height||!Number.isFinite(c.checked_at_ms)||
    c.checked_at_ms<frame.observation.started_windows_qpc_ms||c.checked_at_ms>frame.observation.finished_windows_qpc_ms||
    !c.visible||c.minimized||c.focused!==w.focused||!c.on_monitor||!c.point_owned||!c.point_visible||
    c.cursor_free!==true||c.mouse_buttons_held!==false||c.idle_threshold_ms!==5000||
    !Number.isSafeInteger(c.user_idle_ms)||c.user_idle_ms!<0)return false;
  return c.allowed===true&&c.reason==='safe'&&c.user_idle_ms!>5000||allowRecent&&c.allowed===false&&c.reason==='user_recent_input'&&c.user_idle_ms!<=5000;
}

/** Background activation is authorized only for a positively recognized disconnect UI. */
export function visibleFocusPoint(frame:RecoveryFrame,scene:RecoveryInterpretation,allowRecent=false):RecoveryPointSafety|null {
  if(scene.scene!=='disconnected'||!scene.buttons.some(b=>b.id==='disconnect_ack'||b.id==='reconnect'))return null;
  for(const c of frame.observation.window.recovery_focus_candidates??[]){
    if(!verifiedFocusCandidate(frame,c,allowRecent))continue;
    // Keep the activation click away from all recognized controls, including OK.
    if(scene.buttons.some(b=>c.point.x>=b.x-32&&c.point.x<=b.x+b.width+32&&c.point.y>=b.y-32&&c.point.y<=b.y+b.height+32))continue;
    return c;
  }
  return null;
}
