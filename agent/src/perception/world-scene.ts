import type {RecoveryFrame} from '../recovery/types.js';
/** Legacy calibrated HUD providers can establish a read-only world anchor.
 * They never supply an NPC action, tutorial goal or completion result here. */
export function calibratedWorldAnchor(frame:RecoveryFrame):{x:number;y:number}|null{
  const cv=frame.observation.tutorial_cv;if(!cv?.verified)return null;
  if(cv.source!=='calibrated_cv'||!/^([a-f0-9]{64})$/.test(cv.calibration_sha256)||!/^([a-f0-9]{64})$/.test(cv.reference_sha256)||cv.observation_id!==frame.source.observation_id||cv.capture_sha256!==frame.source.capture_sha256||!cv.regions.length||cv.regions.some(r=>!r.matched))throw new Error('recovery_world_anchor_source_binding');
  const point=cv.safe_focus_point;if(![point.x,point.y].every(Number.isSafeInteger)||point.x<4||point.y<4||point.x>=frame.source.width-4||point.y>=frame.source.height-4)throw new Error('recovery_world_anchor_bounds');
  return structuredClone(point);
}
