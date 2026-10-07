import type { ActionCondition, JsonValue, Observation } from '../core/protocol.js';
import type { BehaviorPorts, BehaviorResult, BehaviorSpec, BodyAction, ExecutionContext, MovementAxis, TargetScopeVerifier, BoundTargetScope } from '../layers/contracts.js';
import { RunLease, cleanupBound } from './lease.js';
import {uiStateRecognized} from '../actions/ui-recognition.js';
import {nextScreenEngage,nextScreenApproach} from './screen-engage.js';
import { bindingError, conditionError, validateConditions, hash, observationError, readKnown, validateBehavior, value, resolveTargetScope, targetScopeKey, type FieldPolicy } from './validation.js';

export interface BehaviorExecutionResult extends BehaviorResult { input_count_scope: 'known' | 'lower_bound'; scenario_effect: 'confirmed' | 'unverified'; }
export interface BehaviorOptions { maxFieldAgeMs?: number; maxObservationAgeMs?: number; trustedSources?: ReadonlyArray<string>; maxEffectFieldAgeMs?: number; targetScopeVerifier?: TargetScopeVerifier; }
export interface BehaviorRunOptions { isCurrent?: () => boolean; }
type Decision = { action: BodyAction; conditions: ActionCondition[]; state: string } | { status: BehaviorResult['status']; reason: string; effect?: boolean };
interface State { initialAlive: boolean; killActionAt?: number; killActionObservation?: string; lastActionAt?: number; lastActionObservation?: string; initialProgress?: number; lastProgress?: number; noProgress: number; recoverAttempts: number; safeFrames: number; lastSafeId?: string; rewardSelected: boolean; questSubmitted?: boolean; trackerBefore?: string[]; controlBefore?: { activation_count: number; state_token: string; frame_nonce: number; layout_id: string }; orientationInstruction?: { id: string; signature_sha256: string }; }
const finish = (status: BehaviorResult['status'], reason: string, effect = false): Decision => ({ status, reason, effect });
const condition = (field: string, v: JsonValue, age: number): ActionCondition => ({ field, op: 'eq', value: v, max_age_ms: age });
const axes = new Set<MovementAxis>(['forward', 'backward', 'strafe_left', 'strafe_right']);
function imageProof(field:import('../core/protocol.js').ObservedField|null):boolean {
  const v=field?.value;return !!(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.capture_sha256==='string'&&/^[a-f0-9]{64}$/.test(v.capture_sha256)&&typeof v.source_frame_id==='string'&&v.source_frame_id.length>0&&typeof v.source_qpc_ms==='number'&&field?.source_clock?.domain==='windows-qpc'&&field.source_clock.value_ms===v.source_qpc_ms);
}

/** Local bounded state machines. Choosing a behavior is outside this action loop. */
export class BehaviorRuntime {
  private active = false;
  private runs = new Map<string, { hash: string; promise: Promise<BehaviorExecutionResult> }>();
  constructor(readonly ports: BehaviorPorts, readonly options: BehaviorOptions = {}) {
    for (const n of [options.maxFieldAgeMs ?? 1000, options.maxObservationAgeMs ?? 1000, options.maxEffectFieldAgeMs ?? options.maxFieldAgeMs ?? 1000]) if (!Number.isSafeInteger(n) || n < 1 || n > 10000) throw new Error('behavior_freshness_bounds');
  }
  run(spec: BehaviorSpec, context: ExecutionContext, options: BehaviorRunOptions = {}): Promise<BehaviorExecutionResult> {
    const frozen = structuredClone(spec); const frozenConditions = structuredClone(context.conditions);
    const ctx = { ...context, conditions: frozenConditions };
    const key = hash([ctx.task_id, ctx.task_revision, ctx.run_epoch, ctx.mode, spec.id]); const signature = hash({ spec: frozen, conditions: ctx.conditions });
    const prior = this.runs.get(key);
    if (prior) return prior.hash === signature ? prior.promise : Promise.resolve(this.empty(spec, 'blocked', 'behavior_id_conflict'));
    if (this.active) return Promise.resolve(this.empty(spec, 'blocked', 'behavior_runtime_busy'));
    this.active = true;
    const promise = this.execute(frozen, ctx, options).finally(() => { this.active = false; }); this.runs.set(key, { hash: signature, promise }); return promise;
  }
  private empty(spec: BehaviorSpec, status: BehaviorResult['status'], reason: string): BehaviorExecutionResult {
    return { ...(spec.kind === 'activate_control' ? { fixture_effect: 'unverified' as const } : {}), id: spec.id, kind: spec.kind, status, reason, input_count_scope: 'known', actions: 0, real_inputs: 0, game_effect: 'unverified', scenario_effect: 'unverified', release: 'unconfirmed', evidence_observation_ids: [] };
  }
  policy(context: Pick<ExecutionContext, 'mode'>): FieldPolicy {
    return { mode: context.mode, now: this.ports.now(), maxAgeMs: this.options.maxFieldAgeMs ?? 1000, ...(this.options.trustedSources ? { trustedSources: this.options.trustedSources } : {}) };
  }
  resolveScope(o: Observation, context: Pick<ExecutionContext,'mode'>, required=false, policy=this.policy(context)) {
    if(policy.mode!==context.mode)return{proof:null,error:'target_scope_policy_mode_changed'};
    return resolveTargetScope(o,policy,this.options.targetScopeVerifier,required);
  }
  private async execute(spec: BehaviorSpec, context: ExecutionContext, options: BehaviorRunOptions): Promise<BehaviorExecutionResult> {
    const result = this.empty(spec, 'failed', 'behavior_exception'); const started = this.ports.now();
    const lease = new RunLease(context.signal, spec.max_duration_ms, () => this.ports.now(), options.isCurrent);
    context = { ...context, signal: lease.signal };
    const state: State = { initialAlive: false, noProgress: 0, recoverAttempts: 0, safeFrames: 0, rewardSelected: false };
    let runId: string | undefined; let previous: Observation | undefined; let initialWindow: string | undefined; let initialScope: string | undefined; let scope: BoundTargetScope | null = null;
    let outcomeUnconfirmed = false; let dispatched = false;
    const current = () => { lease.check(); return true; };
    try {
      validateBehavior(spec);
      validateConditions(context.conditions);
      if (!context.command_id || !context.task_id || !Number.isSafeInteger(context.task_revision) || context.task_revision < 1 || !Number.isSafeInteger(context.run_epoch) || context.run_epoch < 0 || !['live', 'simulated'].includes(context.mode)) throw new Error('behavior_context');
      await lease.wait(() => this.ports.append('behavior_start', { spec, behavior_spec_sha256: hash(spec), schema_version: 'layer-behavior-v1', command_id: context.command_id, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, mode: context.mode, at_ms: started }));
      for (;;) {
        if (!current()) { result.status = 'cancelled'; result.reason = context.signal.aborted ? 'cancelled' : 'task_revision_changed'; break; }
        if (this.ports.now() - started >= spec.max_duration_ms) { result.status = 'blocked'; result.reason = 'behavior_deadline'; break; }
        const o = await lease.wait(() => this.ports.observe()); const policy = this.policy(context);
        if (!current()) { result.status = 'cancelled'; result.reason = 'cancelled_or_revision_changed'; break; }
        if (this.ports.now() - started >= spec.max_duration_ms) { result.status = 'blocked'; result.reason = 'behavior_deadline'; break; }
        const tutorialLesson=spec.kind==='tutorial_orient'||spec.kind==='tutorial_move';
        const confirmingTalk = spec.kind === 'talk_to' && state.lastActionAt !== undefined;
        const confirmingLesson = tutorialLesson && state.lastActionAt !== undefined;
        const confirmingQuest = (spec.kind==='accept_quest'||spec.kind==='turn_in_quest') && state.questSubmitted===true;
        const confirmingEngage = (spec.kind==='engage_target'||spec.kind==='approach_target') && state.lastActionAt!==undefined;
        const confirmingReadonly = confirmingTalk || confirmingLesson || confirmingQuest || confirmingEngage;
        // Relax source age only for terminal, read-only effect verification.
        // No action decision uses this policy after an input has completed.
        const effectPolicy = { ...policy, maxAgeMs: this.options.maxEffectFieldAgeMs ?? policy.maxAgeMs };
        const resolved=this.resolveScope(o,context,spec.kind==='activate_control'||tutorialLesson&&context.mode==='live',confirmingReadonly?{...effectPolicy,maxAgeMs:Math.min(5000,effectPolicy.maxAgeMs)}:policy);
        if(resolved.error){result.status='blocked';result.reason=resolved.error;break;}
        scope=resolved.proof;
        if(scope){
          const key=targetScopeKey(scope);if(initialScope!==undefined&&initialScope!==key){result.status='blocked';result.reason='target_scope_or_native_identity_changed';break;}initialScope??=key;
          if(scope.scope==='recording_fixture'){
            result.fixture_effect='unverified';result.game_effect='unverified';
            if(spec.kind!=='activate_control'){result.status='blocked';result.reason='recording_fixture_requires_control_behavior';break;}
          }
        }else if(initialScope!==undefined){result.status='blocked';result.reason='target_scope_became_unverified';break;}
        const invalid = observationError(o, { ...policy, maxAgeMs: confirmingReadonly ? effectPolicy.maxAgeMs : this.options.maxObservationAgeMs ?? 1000 }, runId) ??
          (confirmingReadonly && (o.at_ms > policy.now || policy.now - o.at_ms > (this.options.maxObservationAgeMs ?? 1000)) ? 'observation_stale_or_future' : null) ??
          (confirmingReadonly && context.mode === 'live' && (readKnown(o, 'window.focused', effectPolicy, true, state.lastActionAt)?.source !== 'window' || readKnown(o, 'window.focused', effectPolicy, true, state.lastActionAt)?.value !== true) ? 'post_effect_foreground_evidence_unknown' : null) ??
          conditionError(o, context.conditions, policy) ?? (confirmingTalk || confirmingQuest || confirmingEngage ? null : bindingError(spec, o, policy));
        if (invalid) { result.status = 'blocked'; result.reason = invalid; break; }
        if (previous && (o.id === previous.id || o.observation_seq <= previous.observation_seq || o.at_ms < previous.at_ms)) { result.status = 'blocked'; result.reason = 'observation_not_new'; break; }
        const windowId = o.window ? `${o.window.token}:${o.window.hwnd}:${o.window.pid}:${o.window.client_width}:${o.window.client_height}` : undefined;
        if (context.mode === 'live' && initialWindow !== undefined && initialWindow !== windowId) { result.status = 'blocked'; result.reason = 'window_binding_changed'; break; }
        initialWindow ??= windowId; runId ??= o.run_id; previous = o;
        result.evidence_observation_ids.push(o.id);
        let decision: Decision;
        const hazardous = value(o, 'hazard.active', confirmingReadonly?effectPolicy:policy, true, confirmingReadonly?state.lastActionAt:undefined) === true;
        if (confirmingTalk) {
          if (hazardous) decision = finish('blocked', 'post_action_hazard_observed');
          else decision=this.confirmTalk(spec,o,effectPolicy,state);
        } else if(confirmingLesson) decision=hazardous?finish('blocked',spec.kind==='tutorial_move'?'tutorial_movement_hazard_observed':'tutorial_orientation_hazard_observed'):this.tutorialLesson(spec,o,effectPolicy,state);
        else if(confirmingQuest) decision=hazardous?finish('blocked','post_action_hazard_observed'):this.dialog(spec,o,effectPolicy,state,80);
        else if(confirmingEngage) decision=hazardous?finish('blocked','post_action_hazard_observed'):(spec.kind==='approach_target'?nextScreenApproach:nextScreenEngage)(spec.params,o,effectPolicy,state);
        else if(hazardous&&(spec.kind==='activate_control'||tutorialLesson)) decision=finish('blocked',tutorialLesson?spec.kind==='tutorial_move'?'tutorial_movement_hazard_observed':'tutorial_orientation_hazard_observed':'control_activation_hazard_observed');
        else if (hazardous && spec.kind !== 'avoid_hazard') {
          const released = await lease.wait(() => this.ports.release('hazard_preempt'));
          if (released !== 'confirmed') { outcomeUnconfirmed = true; result.status = 'blocked'; result.reason = 'hazard_release_unconfirmed'; break; }
          decision = this.avoid(o, policy, state, 200, 1, false);
          await lease.wait(() => this.ports.append('behavior_hazard_preempt', { behavior_id: spec.id, observation_id: o.id }));
        } else {
          if(spec.kind==='talk_to'&&state.lastActionAt===undefined){const trackerPolicy={...policy,trustedSources:[...(policy.trustedSources??['cv','window']),'local_ocr']},entries=readKnown(o,'quest.tracker.entries',trackerPolicy,true),proof=readKnown(o,'quest.tracker.source',trackerPolicy,true);if(entries&&imageProof(proof)&&Array.isArray(entries.value))state.trackerBefore=entries.value.filter(e=>e&&typeof e==='object'&&!Array.isArray(e)&&typeof e.quest_id==='string').map(e=>String((e as Record<string,JsonValue>).quest_id));}
          decision = this.decide(spec, o, policy, state);
        }
        await lease.wait(() => this.ports.append('behavior_state', { behavior_id: spec.id, observation_id: o.id, state: 'action' in decision ? decision.state : decision.reason, actions: result.actions, task_revision: context.task_revision, run_epoch: context.run_epoch }));
        if ('status' in decision) {
          result.status = decision.status; result.reason = decision.reason; if(scope?.scope==='recording_fixture'){result.fixture_effect=decision.effect?'confirmed':'unverified';result.game_effect='unverified';}else result.game_effect = decision.effect ? 'confirmed' : 'unverified'; break;
        }
        if(confirmingReadonly){result.status='blocked';result.reason='readonly_effect_cannot_dispatch';break;}
        if (result.actions >= spec.max_actions) { result.status = 'blocked'; result.reason = 'behavior_action_budget'; break; }
        if (!current()) { result.status = 'cancelled'; result.reason = 'cancelled_or_revision_changed'; break; }
        // An action must fit the remaining behavior lease, not merely start within it.
        if (this.ports.now() + decision.action.duration_ms > started + spec.max_duration_ms) { result.status = 'blocked'; result.reason = 'behavior_deadline'; break; }
        const conditions = [...context.conditions, ...decision.conditions];
        if (typeof spec.params.target_signature === 'string') conditions.push(condition('target.signature', spec.params.target_signature, policy.maxAgeMs));
        if (typeof spec.params.target_instance_id === 'string') conditions.push(condition('target.instance_id', spec.params.target_instance_id, policy.maxAgeMs));
        if (typeof spec.params.destination_id === 'string') conditions.push(condition('navigation.destination_id', spec.params.destination_id, policy.maxAgeMs));
        const guard = conditionError(o, conditions, { ...policy, now: this.ports.now() });
        if (guard) { result.status = 'blocked'; result.reason = guard; break; }
        const commandId = `behavior-action-${hash([context.command_id, context.task_id, context.task_revision, context.run_epoch, spec.id, result.actions]).slice(0, 24)}`;
        await lease.wait(() => this.ports.append('behavior_action_intent', { behavior_id: spec.id, command_id: commandId, parent_command_id: context.command_id, action_index: result.actions, action: decision.action, observation_id: o.id, task_revision: context.task_revision, run_epoch: context.run_epoch, mode: context.mode }));
        if (!current()) { result.status = 'cancelled'; result.reason = 'cancelled_or_revision_changed'; break; }
        const out = await lease.wait(() => { dispatched = true; return this.ports.executeBody(decision.action, o, { ...context, command_id: commandId, conditions }); });
        dispatched = false; result.actions++;
        if (!Number.isSafeInteger(out.real_inputs) || out.real_inputs < 0) { result.input_count_scope = 'lower_bound'; throw new Error('body_input_count_invalid'); }
        result.real_inputs += out.real_inputs;
        if ((out as typeof out & { input_count_scope?: 'known' | 'lower_bound' }).input_count_scope === 'lower_bound') result.input_count_scope = 'lower_bound';
        if (context.mode === 'simulated' && out.real_inputs !== 0) throw new Error('simulated_body_real_input');
        if (context.mode === 'live' && decision.action.kind !== 'wait' && out.status === 'completed' && out.real_inputs === 0) throw new Error('body_completed_without_real_input');
        if (!['completed', 'blocked', 'cancelled', 'failed'].includes(out.status) || out.before_observation_id !== o.id || !Number.isSafeInteger(out.started_at_ms) || out.started_at_ms < o.at_ms || !Number.isSafeInteger(out.finished_at_ms) || out.finished_at_ms < out.started_at_ms || out.finished_at_ms > this.ports.now()) throw new Error('body_outcome_binding');
        outcomeUnconfirmed ||= out.release !== 'confirmed';
        await lease.wait(() => this.ports.append('behavior_action_result', { behavior_id: spec.id, command_id: commandId, action_index: result.actions - 1, outcome: out }));
        if (result.input_count_scope === 'lower_bound') { result.status = 'blocked'; result.reason = 'body_input_count_lower_bound'; break; }
        if (out.release !== 'confirmed') { result.status = 'blocked'; result.reason = 'body_release_unconfirmed'; break; }
        if (out.status !== 'completed') { result.status = out.status; result.reason = out.reason ?? `body_${out.status}`; break; }
        if(decision.state==='accepting_quest'||decision.state==='turning_in_quest')state.questSubmitted=true;
        if (decision.action.kind !== 'wait') { state.lastActionAt = out.finished_at_ms; state.lastActionObservation = o.id; }
        if (decision.action.kind === 'cast' && spec.kind === 'kill_target') { state.killActionAt = out.finished_at_ms; state.killActionObservation = o.id; }
      }
    } catch (error) {
      if (dispatched) { result.input_count_scope = 'lower_bound'; result.actions++; }
      result.status = lease.signal.reason === 'deadline' ? 'blocked' : lease.signal.aborted ? 'cancelled' : 'failed'; result.reason = error instanceof Error ? error.message : 'behavior_exception'; result.game_effect = 'unverified'; if(result.fixture_effect!==undefined)result.fixture_effect='unverified';
    } finally {
      try { const released = await cleanupBound(this.ports.release(result.reason)); result.release = released === 'confirmed' && !outcomeUnconfirmed ? 'confirmed' : 'unconfirmed'; }
      catch { result.release = 'unconfirmed'; }
      if (result.release !== 'confirmed' && result.status === 'completed') { result.status = 'blocked'; result.reason = 'behavior_release_unconfirmed'; result.game_effect = 'unverified'; if(result.fixture_effect!==undefined)result.fixture_effect='unverified'; }
      if (context.mode === 'simulated') { result.scenario_effect = result.game_effect; result.game_effect = 'unverified'; }
      try { await cleanupBound(this.ports.append('behavior_result', { ...result, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, mode: context.mode })); }
      catch { result.status = 'failed'; result.reason = 'behavior_result_log_failed'; result.game_effect = 'unverified'; if(result.fixture_effect!==undefined)result.fixture_effect='unverified'; result.scenario_effect = 'unverified'; }
      lease.close();
    }
    return result;
  }
  private decide(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State): Decision {
    const duration = Number(spec.params.action_duration_ms ?? spec.params.step_duration_ms ?? 200);
    if (spec.kind === 'activate_control') return this.activateControl(spec,o,p,s,Number(spec.params.action_duration_ms??50));
    if (spec.kind === 'tutorial_orient'||spec.kind==='tutorial_move') return this.tutorialLesson(spec,o,p,s);
    if (spec.kind === 'kill_target') return this.kill(spec, o, p, s, duration);
    if (spec.kind === 'engage_target') return nextScreenEngage(spec.params,o,p,s);
    if (spec.kind === 'approach_target') return nextScreenApproach(spec.params,o,p,s);
    if (spec.kind === 'loot_target') return this.loot(spec, o, p, s, duration);
    if (['talk_to', 'accept_quest', 'turn_in_quest'].includes(spec.kind)) return this.dialog(spec, o, p, s, duration);
    if (spec.kind === 'move_to' || spec.kind === 'fly_to') return this.navigate(spec, o, p, s, duration);
    if (spec.kind === 'avoid_hazard') return this.avoid(o, p, s, duration, Number(spec.params.safe_observations ?? 2), true);
    return this.recover(spec, o, p, s, duration);
  }
  private confirmTalk(spec:BehaviorSpec,o:Observation,p:FieldPolicy,s:State):Decision {
    const panel=readKnown(o,'dialog.npc_quest_panel',p,true,s.lastActionAt),v=panel?.value;
    if(v&&typeof v==='object'&&!Array.isArray(v)&&v.kind==='npc_quest'&&v.target_signature===spec.params.target_signature&&v.portrait===true&&v.parchment===true&&Array.isArray(v.controls)&&v.controls.some(c=>['accept','reject','continue','complete'].includes(String(c)))&&typeof v.signature_sha256==='string'&&/^[a-f0-9]{64}$/.test(v.signature_sha256)&&typeof v.roi_sha256==='string'&&/^[a-f0-9]{64}$/.test(v.roi_sha256)&&v.layout_id===value(o,'ui.layout_id',p,true,s.lastActionAt))return finish('completed','npc_quest_panel_confirmed',true);
    const ocrPolicy={...p,trustedSources:[...(p.trustedSources??['cv','window']),'local_ocr']};
    const paired=readKnown(o,'dialog.paired_ocr_proof',ocrPolicy,true,s.lastActionAt);
    const open=readKnown(o,'dialog.open',imageProof(paired)?ocrPolicy:p,true,s.lastActionAt),target=readKnown(o,'dialog.target_signature',imageProof(paired)?ocrPolicy:p,true,s.lastActionAt);
    if(open?.value===true&&target?.value===spec.params.target_signature)return finish('completed','dialog_open_confirmed',true);
    const entries=readKnown(o,'quest.tracker.entries',ocrPolicy,true,s.lastActionAt),proof=readKnown(o,'quest.tracker.source',ocrPolicy,true,s.lastActionAt);
    if(s.trackerBefore&&imageProof(proof)&&entries&&Array.isArray(entries.value)&&entries.value.some(e=>e&&typeof e==='object'&&!Array.isArray(e)&&e.target_signature===spec.params.target_signature&&typeof e.quest_id==='string'&&!s.trackerBefore!.includes(e.quest_id)))return finish('completed','quest_tracker_entry_added_confirmed',true);
    return finish('blocked','dialog_effect_not_new_or_unconfirmed');
  }
  private tutorialLesson(spec:BehaviorSpec,o:Observation,p:FieldPolicy,s:State):Decision {
    const moving=spec.kind==='tutorial_move',prefix=moving?'tutorial_movement':'tutorial_orientation';
    const layout=readKnown(o,'ui.layout_id',p,true,s.lastActionAt),field=readKnown(o,'ui.state',p,true,s.lastActionAt);
    const instruction=readKnown(o,'tutorial.instruction',p,true,s.lastActionAt);
    if(!layout||layout.value!==spec.params.layout_id||p.mode==='live'&&layout.source!=='cv')return finish('blocked',prefix+'_layout_unknown_or_changed');
    const current=(f:typeof field)=>f!==null&&f.captured_at_ms===layout.captured_at_ms&&(p.mode!=='live'||f.source==='cv');
    const row=field?.value;
    const ui=current(field)&&row!==null&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===4&&typeof row.id==='string'&&typeof row.confidence==='number'&&uiStateRecognized(o,row.confidence)&&typeof row.signature_sha256==='string'&&/^[a-f0-9]{64}$/.test(row.signature_sha256)&&(row.hard_stop===null||row.hard_stop===false)?row:null;
    const text=instruction?.value;
    const label=current(instruction)&&text!==null&&typeof text==='object'&&!Array.isArray(text)&&typeof text.id==='string'&&text.id.length>0&&!['unknown','unsupported','unavailable'].includes(text.id)&&typeof text.signature_sha256==='string'&&/^[a-f0-9]{64}$/.test(text.signature_sha256)?{id:text.id,signature_sha256:text.signature_sha256}:null;
    const hardStop=readKnown(o,'ui.hard_stop',p,true,s.lastActionAt);
    if(hardStop&&hardStop.value!==false&&hardStop.value!==null||current(field)&&row!==null&&typeof row==='object'&&!Array.isArray(row)&&row.hard_stop!==null&&row.hard_stop!==false)return finish('blocked',prefix+'_hard_stop');
    const matches=readKnown(o,'ui.skill_matches',p,true,s.lastActionAt);
    const uniqueMatch=(signature:JsonValue|undefined)=>typeof signature==='string'&&current(matches)&&Array.isArray(matches?.value)&&matches.value.filter(v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&typeof v.skill_id==='string'&&v.signature_sha256===signature).length===1;
    if(s.lastActionAt!==undefined){
      if(s.lastActionObservation===o.id)return finish('blocked',prefix+'_effect_not_new');
      if(ui&&ui.id!==spec.params.state_id&&!['unknown','unsupported','unavailable'].includes(String(ui.id))&&uniqueMatch(ui.signature_sha256))return finish('completed',prefix+'_state_changed',true);
      if(label&&s.orientationInstruction&&(label.id!==s.orientationInstruction.id||label.signature_sha256!==s.orientationInstruction.signature_sha256))return finish('completed',prefix+'_instruction_changed',true);
      return finish('blocked',prefix+'_effect_unverified');
    }
    const cursor=readKnown(o,'input.cursor_free',p,true),held=readKnown(o,'input.mouse_buttons_held',p,true),mode=readKnown(o,'input.mouse_mode',p,true);
    if(!ui||Object.keys(ui).length!==4||ui.id!==spec.params.state_id||ui.signature_sha256!==spec.params.signature_sha256)return finish('blocked',prefix+'_state_or_signature_unbound');
    if(!uniqueMatch(spec.params.signature_sha256))return finish('blocked',prefix+'_learned_signature_unbound');
    if(!cursor||!held||cursor.value!==true||held.value!==false||cursor.captured_at_ms!==layout.captured_at_ms||held.captured_at_ms!==layout.captured_at_ms||p.mode==='live'&&(cursor.source!=='window'||held.source!=='window'))return finish('blocked',prefix+'_cursor_unsafe');
    if(!current(mode)||mode?.value!=='world')return finish('blocked',prefix+'_mouse_mode_unknown');
    const conditions=[condition('ui.state',ui,p.maxAgeMs),condition('ui.layout_id',layout.value,p.maxAgeMs),condition('ui.skill_matches',matches!.value,p.maxAgeMs),condition('input.cursor_free',true,p.maxAgeMs),condition('input.mouse_buttons_held',false,p.maxAgeMs),condition('input.mouse_mode','world',p.maxAgeMs)];
    if(label)s.orientationInstruction=label;
    if(moving){
      const ground=readKnown(o,'player.movement_mode',p,true),binding=readKnown(o,'input.forward_binding',p,true),b=binding?.value;
      if(!current(ground)||ground?.value!=='ground')return finish('blocked','tutorial_movement_ground_mode_unknown');
      if(!current(binding)||!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==3||b.mode!=='ground'||b.layout_id!==layout.value||!Array.isArray(b.keys)||b.keys.length!==1||b.keys[0]!=='W')return finish('blocked','tutorial_movement_forward_binding_unbound');
      return{action:{kind:'move',axis:'forward',duration_ms:Number(spec.params.action_duration_ms)},conditions:[...conditions,condition('player.movement_mode','ground',p.maxAgeMs),condition('input.forward_binding',b,p.maxAgeMs)],state:'tutorial_movement_forward'};
    }
    if(!o.window||!Number.isSafeInteger(o.window.client_width)||!Number.isSafeInteger(o.window.client_height)||o.window.client_width<1||o.window.client_height<1)return finish('blocked',prefix+'_client_unknown');
    const dx=Math.round(o.window.client_width*Number(spec.params.dx_fraction)),x=Math.floor(o.window.client_width*Number(spec.params.origin_x_fraction)),y=Math.floor(o.window.client_height*Number(spec.params.origin_y_fraction));
    if(dx<1||dx>32767||x<0||y<0||x+dx>=o.window.client_width||y>=o.window.client_height)return finish('blocked',prefix+'_curve_outside_client');
    return{action:{kind:'turn',dx,duration_ms:Number(spec.params.action_duration_ms),camera_sweep:{origin:{x,y},steps:4,return_to_origin:true}},conditions,state:'tutorial_orientation_sweep'};
  }
  private activateControl(spec:BehaviorSpec,o:Observation,p:FieldPolicy,s:State,duration:number):Decision {
    const layout=readKnown(o,'ui.layout_id',p,true,s.lastActionAt),state=readKnown(o,'ui.control_state',p,true,s.lastActionAt);
    const elements=readKnown(o,'ui.elements',p,true),mode=readKnown(o,'input.mouse_mode',p,true);
    if(!layout||typeof layout.value!=='string'||!state||!state.value||Array.isArray(state.value)||typeof state.value!=='object'||
      p.mode==='live'&&(layout.source!=='cv'||state.source!=='cv'))return finish('blocked','control_state_or_layout_unknown');
    const row=state.value;
    if(Object.keys(row).length!==5||row.control_id!==spec.params.control_id||row.layout_id!==layout.value||
      !Number.isSafeInteger(row.activation_count)||Number(row.activation_count)<0||typeof row.state_token!=='string'||!row.state_token||row.state_token.length>256||
      !Number.isSafeInteger(row.frame_nonce)||Number(row.frame_nonce)<0)return finish('blocked','control_state_unbound');
    if(s.lastActionAt!==undefined){
      const before=s.controlBefore;
      if(!before||s.lastActionObservation===o.id||row.layout_id!==before.layout_id||Number(row.activation_count)!==before.activation_count+1||
        row.state_token===before.state_token||Number(row.frame_nonce)<=before.frame_nonce)return finish('blocked','control_effect_not_new_or_unconfirmed');
      return finish('completed','control_activation_confirmed',true);
    }
    if(!elements||!Array.isArray(elements.value)||!mode||mode.value!=='ui'||p.mode==='live'&&(elements.source!=='cv'||mode.source!=='cv'))return finish('blocked','control_elements_or_mode_unknown');
    const matching=elements.value.filter(v=>v!==null&&!Array.isArray(v)&&typeof v==='object'&&v.id===spec.params.control_id);
    if(matching.length!==1)return finish('blocked','control_element_missing_or_ambiguous');
    const element=matching[0] as {[key:string]:JsonValue};
    if(Object.keys(element).length!==5||element.enabled!==true||element.layout_id!==layout.value||!Number.isSafeInteger(element.x)||!Number.isSafeInteger(element.y)||
      Number(element.x)<0||Number(element.y)<0||!o.window||Number(element.x)>=o.window.client_width||Number(element.y)>=o.window.client_height)return finish('blocked','control_element_unbound');
    s.controlBefore={activation_count:Number(row.activation_count),state_token:row.state_token,frame_nonce:Number(row.frame_nonce),layout_id:layout.value};
    return {action:{kind:'click',element_id:String(spec.params.control_id),button:'left',x:Number(element.x),y:Number(element.y),duration_ms:duration},
      conditions:[condition('ui.layout_id',layout.value,p.maxAgeMs),condition('ui.elements',elements.value,p.maxAgeMs),condition('ui.control_state',row,p.maxAgeMs),condition('input.mouse_mode','ui',p.maxAgeMs)],state:'activating_control'};
  }
  private kill(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State, duration: number): Decision {
    const dead = value(o, 'target.dead', p, true, s.killActionAt);
    const alive = value(o, 'target.alive', p, true, s.killActionAt);
    const observedAlive = alive === true || dead === false;
    const observedDead = dead === true || alive === false;
    if (observedAlive && observedDead) return finish('blocked', 'target_life_conflict');
    if (observedDead) return s.initialAlive && s.killActionAt !== undefined && s.killActionObservation !== o.id ? finish('completed', 'bound_target_death_observed_contribution_unproven', true) : finish('blocked', 'target_already_dead');
    if (!observedAlive) return finish('blocked', 'target_life_unknown');
    s.initialAlive = true;
    if (value(o, 'target.hostile', p) !== true || value(o, 'target.attackable', p) !== true) return finish('blocked', 'target_attack_permission_unknown');
    type Priority = { ability: string; category: 'damage' | 'interrupt' | 'control' | 'defensive' | 'heal'; conditions: ActionCondition[] };
    const priorities = structuredClone((spec.params.skill_priority ?? []) as unknown as Priority[]);
    if (typeof spec.params.attack_ability === 'string' && !priorities.some(x => x.ability === spec.params.attack_ability)) priorities.push({ ability: spec.params.attack_ability, category: 'damage', conditions: [] });
    const aliveCondition = dead === false ? condition('target.dead', false, p.maxAgeMs) : condition('target.alive', true, p.maxAgeMs);
    let knownReadiness = false;
    for (const entry of priorities) {
      if (conditionError(o, entry.conditions, p)) continue;
      const field = `combat.ability.${entry.ability}.ready`;
      const ready = readKnown(o, field, p, true);
      if (!ready || p.mode === 'live' && ready.source !== 'cv' || typeof ready.value !== 'boolean') continue;
      knownReadiness = true;
      if (ready.value) return { action: { kind: 'cast', ability: entry.ability, duration_ms: duration }, conditions: [...entry.conditions, aliveCondition, condition(field, true, p.maxAgeMs), condition('target.hostile', true, p.maxAgeMs), condition('target.attackable', true, p.maxAgeMs)], state: `casting_${entry.category}` };
    }
    if (!knownReadiness) return finish('blocked', 'ability_ready_unknown_or_not_current_cv');
    return { action: { kind: 'wait', duration_ms: duration }, conditions: [], state: 'waiting_ability' };
  }

  private loot(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State, duration: number): Decision {
    if (value(o, 'loot.target_signature', p, true, s.lastActionAt) === spec.params.target_signature && value(o, 'loot.completed', p, true, s.lastActionAt) === true) return finish('completed', s.lastActionAt === undefined ? 'already_looted' : 'loot_confirmed', true);
    if (value(o, 'target.dead', p) !== true && value(o, 'target.alive', p) !== false) return finish('blocked', 'loot_dead_target_unknown');
    if (value(o, 'target.lootable', p) !== true) return finish('blocked', 'target_lootable_unknown_or_false');
    return { action: { kind: 'interact', target_signature: String(spec.params.target_signature), duration_ms: duration }, conditions: [condition('target.lootable', true, p.maxAgeMs)], state: 'looting' };
  }
  private dialog(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State, duration: number): Decision {
    const q = String(spec.params.quest_id); const after = s.lastActionAt;
    if (spec.kind === 'accept_quest' && value(o, `quest.${q}.accepted`, p, true, after) === true) return finish('completed', after === undefined ? 'quest_already_accepted' : 'quest_accept_confirmed', true);
    if (spec.kind === 'turn_in_quest' && value(o, `quest.${q}.turned_in`, p, true, after) === true) {
      if (value(o, `quest.${q}.reward_received`, p, true, after) !== true) return finish('blocked', 'quest_reward_evidence_pending');
      if (spec.params.reward_policy === 'explicit' && value(o, `quest.${q}.received_reward_id`, p, true, after) !== spec.params.reward_id) return finish('blocked', 'quest_received_reward_unknown_or_mismatch');
      return finish('completed', after === undefined ? 'quest_already_delivered' : 'quest_turn_in_reward_confirmed', true);
    }
    if (spec.kind === 'turn_in_quest' && value(o, `quest.${q}.completed`, p) !== true) return finish('blocked', 'quest_completion_unknown');
    const open = value(o, 'dialog.open', p, true);
    if(spec.kind==='talk_to'&&spec.params.screen_target_positive_only===true&&after===undefined&&open!==true)return this.positiveScreenTalk(spec,o,p,duration);
    if (open === false) {
      const screen = value(o, 'target.screen_interaction', p, true);
      if (screen !== undefined) {
        if (!screen || Array.isArray(screen) || typeof screen !== 'object' || screen.signature !== spec.params.target_signature || screen.enabled !== true || typeof screen.id !== 'string' || !Number.isSafeInteger(screen.x) || !Number.isSafeInteger(screen.y)) return finish('blocked', 'screen_interaction_target_unknown');
        const coverage = readKnown(o, 'dialog.absence_coverage_complete', p, true), absent = readKnown(o, 'dialog.open', p, true);
        if (coverage?.value !== true || p.mode === 'live' && (coverage.source !== 'cv' || absent?.source !== 'cv')) return finish('blocked', 'dialog_absence_coverage_unknown');
        return { action: { kind: 'screen_interact', target_signature: String(spec.params.target_signature), element_id: screen.id, x: Number(screen.x), y: Number(screen.y), duration_ms: Math.min(duration, 150) }, conditions: [condition('dialog.open', false, p.maxAgeMs), condition('dialog.absence_coverage_complete', true, p.maxAgeMs), condition('target.screen_interaction', screen, p.maxAgeMs)], state: 'opening_dialog_at_current_screen_target' };
      }
      return { action: { kind: 'interact', target_signature: String(spec.params.target_signature), duration_ms: duration }, conditions: [condition('dialog.open', false, p.maxAgeMs)], state: 'opening_dialog' };
    }
    if (open !== true || value(o, 'dialog.target_signature', p, true) !== spec.params.target_signature) return finish('blocked', 'dialog_binding_unknown');
    if (spec.kind === 'talk_to') {
      if (after !== undefined && !readKnown(o, 'dialog.open', p, true, after)) return finish('blocked', 'dialog_effect_not_new');
      return finish('completed', after === undefined ? 'dialog_already_open' : 'dialog_open_confirmed', true);
    }
    const elementsField = readKnown(o, 'dialog.elements', p, true);
    if (!elementsField || !Array.isArray(elementsField.value)) return finish('blocked', 'dialog_elements_unknown');
    const elements = elementsField.value;
    const get = (role: string, rewardId?: string): Record<string, JsonValue> | null => {
      const selected = elements.filter(e => e !== null && typeof e === 'object' && !Array.isArray(e) && e.role === role && e.quest_id === q && e.enabled === true && (rewardId === undefined || e.reward_id === rewardId));
      if (selected.length !== 1) return null;
      const e = selected[0] as Record<string, JsonValue>;
      if (typeof e.id !== 'string' || !e.id || typeof e.x !== 'number' || typeof e.y !== 'number' || !Number.isSafeInteger(e.x) || !Number.isSafeInteger(e.y) || e.x < 0 || e.y < 0 || o.window && (e.x >= o.window.client_width || e.y >= o.window.client_height)) return null;
      return e;
    };
    let e: Record<string, JsonValue> | null;
    if (spec.kind === 'accept_quest') e = get('accept');
    else {
      if (spec.params.reward_policy === 'explicit' && !s.rewardSelected) {
        e = get('reward', String(spec.params.reward_id));
        if (e) { s.rewardSelected = true; return { action: { kind: 'click', element_id: String(e.id), button: 'left', x: Number(e.x), y: Number(e.y), duration_ms: duration }, conditions: [condition('dialog.elements', elements, p.maxAgeMs)], state: 'selecting_reward' }; }
        return finish('blocked', 'explicit_reward_element_unknown');
      }
      if (spec.params.reward_policy === 'explicit' && s.rewardSelected && value(o, `quest.${q}.selected_reward_id`, p, true, after) !== spec.params.reward_id) return finish('blocked', 'quest_reward_selection_unconfirmed');
      // No reward policy never silently chooses an offered reward.
      if (spec.params.reward_policy === 'none' && elements.some(e => e !== null && typeof e === 'object' && !Array.isArray(e) && e.role === 'reward' && e.quest_id === q)) return finish('blocked', 'reward_selection_required');
      e = get('complete') ?? get('turn_in');
    }
    if (!e) return finish('blocked', 'quest_dialog_element_unknown_or_ambiguous');
    return { action: { kind: 'click', element_id: String(e.id), button: 'left', x: Number(e.x), y: Number(e.y), duration_ms: duration }, conditions: [condition('dialog.elements', elements, p.maxAgeMs)], state: spec.kind === 'accept_quest' ? 'accepting_quest' : 'turning_in_quest' };
  }
  private positiveScreenTalk(spec:BehaviorSpec,o:Observation,p:FieldPolicy,duration:number):Decision {
    const layout=readKnown(o,'ui.layout_id',p,true),target=readKnown(o,'target.signature',p,true),screen=readKnown(o,'target.screen_interaction',p,true),surface=readKnown(o,'target.world_npc_surface',p,true),instruction=readKnown(o,'tutorial.instruction',p,true);
    const current=(f:typeof layout)=>f!==null&&layout!==null&&f.captured_at_ms===layout.captured_at_ms&&(p.mode!=='live'||f.source==='cv');
    if(!current(layout)||typeof layout?.value!=='string'||!current(target)||target?.value!==spec.params.target_signature||!current(instruction)||instruction?.value!=='与吉安娜·普罗德摩尔交谈')return finish('blocked','positive_screen_talk_identity_or_instruction_unknown');
    const point=screen?.value,body=surface?.value;
    if(!current(screen)||!point||Array.isArray(point)||typeof point!=='object'||Object.keys(point).length!==6||point.signature!==spec.params.target_signature||point.layout_id!==layout.value||point.enabled!==true||typeof point.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(point.id)||!Number.isSafeInteger(point.x)||!Number.isSafeInteger(point.y))return finish('blocked','positive_screen_talk_point_unbound');
    if(!current(surface)||!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length!==10||body.id!==point.id||body.signature!==point.signature||body.layout_id!==point.layout_id||body.visible!==true||typeof body.frame_id!=='string'||!body.frame_id||body.frame_id.length>128||typeof body.roi_id!=='string'||!body.roi_id||body.roi_id.length>128||typeof body.roi_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.roi_sha256)||typeof body.calibration_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.calibration_sha256))return finish('blocked','positive_screen_talk_surface_unbound');
    const rect=body.rect,center=body.point,w=o.window;
    if(!rect||Array.isArray(rect)||typeof rect!=='object'||Object.keys(rect).length!==4||!center||Array.isArray(center)||typeof center!=='object'||Object.keys(center).length!==2||center.x!==point.x||center.y!==point.y||!w||![rect.x,rect.y,rect.width,rect.height,w.client_width,w.client_height].every(Number.isSafeInteger)||Number(rect.x)<0||Number(rect.y)<0||Number(rect.width)<5||Number(rect.height)<5||Number(rect.x)+Number(rect.width)>w.client_width||Number(rect.y)+Number(rect.height)>w.client_height||Number(point.x)-2<Number(rect.x)||Number(point.y)-2<Number(rect.y)||Number(point.x)+2>=Number(rect.x)+Number(rect.width)||Number(point.y)+2>=Number(rect.y)+Number(rect.height))return finish('blocked','positive_screen_talk_surface_point_outside_body');
    const cursor=readKnown(o,'input.cursor_free',p,true),held=readKnown(o,'input.mouse_buttons_held',p,true);
    if(!cursor||!held||cursor.value!==true||held.value!==false||cursor.captured_at_ms!==layout.captured_at_ms||held.captured_at_ms!==layout.captured_at_ms||p.mode==='live'&&(cursor.source!=='window'||held.source!=='window'))return finish('blocked','positive_screen_talk_cursor_unsafe');
    const uiConditions:ActionCondition[]=[];
    if(Object.hasOwn(o.fields,'ui.state')){
      const state=readKnown(o,'ui.state',p,true),row=state?.value;
      if(!current(state)||!row||Array.isArray(row)||typeof row!=='object'||Object.keys(row).length!==4||typeof row.id!=='string'||!row.id||['unknown','unsupported','unavailable'].includes(row.id)||typeof row.confidence!=='number'||!Number.isFinite(row.confidence)||!uiStateRecognized(o,row.confidence)||typeof row.signature_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.signature_sha256)||row.hard_stop!==null)return finish('blocked','positive_screen_talk_ui_state_unbound');
      uiConditions.push(condition('ui.state',row,p.maxAgeMs));
    }
    const hardStop=readKnown(o,'ui.hard_stop',p,true);
    if(hardStop&&hardStop.value!==false&&hardStop.value!==null)return finish('blocked','positive_screen_talk_hard_stop');
    return{action:{kind:'screen_interact',target_signature:String(spec.params.target_signature),element_id:point.id,x:Number(point.x),y:Number(point.y),duration_ms:Math.min(duration,150)},conditions:[condition('target.signature',target!.value,p.maxAgeMs),condition('target.screen_interaction',point,p.maxAgeMs),condition('target.world_npc_surface',body,p.maxAgeMs),condition('tutorial.instruction',instruction!.value,p.maxAgeMs),condition('ui.layout_id',layout.value,p.maxAgeMs),condition('input.cursor_free',true,p.maxAgeMs),condition('input.mouse_buttons_held',false,p.maxAgeMs),...uiConditions],state:'opening_dialog_at_positive_world_npc_surface'};
  }
  private navigate(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State, duration: number): Decision {
    const expectedMode = spec.kind === 'move_to' ? 'ground' : spec.params.flight_mode;
    if (spec.kind === 'fly_to' && expectedMode !== 'steady_flight') return finish('blocked', `unsupported_flight_mode:${String(expectedMode)}`);
    if (value(o, 'navigation.mode', p, true) !== expectedMode) return finish('blocked', 'navigation_mode_unknown_or_mismatch');
    if (value(o, 'navigation.arrived', p, true, s.lastActionAt) === true) return finish('completed', s.lastActionAt === undefined ? 'already_at_destination' : 'destination_arrival_confirmed', true);
    if (value(o, 'navigation.arrived', p, true) !== false) return finish('blocked', 'navigation_arrival_unknown');
    const progress = value(o, 'navigation.progress', p, true);
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0) return finish('blocked', 'navigation_progress_unknown');
    if (s.lastProgress !== undefined && s.lastActionAt !== undefined) { s.noProgress = progress > s.lastProgress ? 0 : s.noProgress + 1; if (s.noProgress >= 3) return finish('blocked', 'navigation_no_progress'); }
    s.lastProgress = progress;
    if (value(o, 'navigation.stuck', p, true) === true) return finish('blocked', 'navigation_stuck');
    const aligned = value(o, 'navigation.heading_aligned', p, true);
    if (aligned === false) {
      const dx = value(o, 'navigation.next_turn_dx', p, true);
      if (typeof dx !== 'number' || !Number.isSafeInteger(dx) || dx === 0 || Math.abs(dx) > 500) return finish('blocked', 'navigation_turn_unknown');
      return { action: { kind: 'turn', dx, duration_ms: duration }, conditions: [condition('navigation.heading_aligned', false, p.maxAgeMs), condition('navigation.next_turn_dx', dx, p.maxAgeMs)], state: 'correcting_heading' };
    }
    if (aligned !== true) return finish('blocked', 'navigation_heading_unknown');
    return { action: spec.kind === 'fly_to' ? { kind: 'fly', axis: 'forward', duration_ms: duration } : { kind: 'move', axis: 'forward', duration_ms: duration }, conditions: [condition('navigation.heading_aligned', true, p.maxAgeMs), condition('navigation.mode', expectedMode!, p.maxAgeMs)], state: 'advancing' };
  }
  private avoid(o: Observation, p: FieldPolicy, s: State, duration: number, safeRequired: number, canFinish: boolean): Decision {
    const active = value(o, 'hazard.active', p, true, s.lastActionAt);
    if (active === false) {
      if (s.lastSafeId !== o.id) { s.safeFrames++; s.lastSafeId = o.id; }
      if (s.safeFrames >= safeRequired && canFinish) return finish('completed', 'hazard_clear_confirmed', true);
      return { action: { kind: 'wait', duration_ms: duration }, conditions: [condition('hazard.active', false, p.maxAgeMs)], state: 'confirming_safe' };
    }
    if (active !== true) return finish('blocked', 'hazard_state_unknown');
    s.safeFrames = 0;
    const axis = value(o, 'hazard.safe_axis', p, true);
    if (typeof axis !== 'string' || !axes.has(axis as MovementAxis)) return finish('blocked', 'hazard_safe_direction_unknown');
    return { action: { kind: 'move', axis: axis as MovementAxis, duration_ms: duration }, conditions: [condition('hazard.active', true, p.maxAgeMs), condition('hazard.safe_axis', axis, p.maxAgeMs)], state: 'avoiding_hazard' };
  }
  private recover(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State, duration: number): Decision {
    if (value(o, 'navigation.mode', p) !== 'ground') return finish('blocked', 'recover_mode_unsupported_or_unknown');
    const progress = value(o, 'navigation.progress', p, true, s.lastActionAt);
    if (typeof progress !== 'number' || !Number.isFinite(progress)) return finish('blocked', 'recover_progress_unknown');
    s.initialProgress ??= progress;
    const stuck = value(o, 'navigation.stuck', p, true, s.lastActionAt);
    if (s.lastActionAt !== undefined && stuck === false && progress > s.initialProgress) return finish('completed', 'recover_progress_confirmed', true);
    if (stuck !== true) return finish('blocked', 'recover_stuck_evidence_missing');
    if (value(o, 'navigation.recover_safe', p, true) !== true) return finish('blocked', 'recover_safe_space_unknown');
    if (s.recoverAttempts >= Number(spec.params.max_recovery_attempts ?? 3)) return finish('blocked', 'recover_attempt_budget');
    const recovery: BodyAction[] = [{ kind: 'move', axis: 'backward', duration_ms: duration }, { kind: 'move', axis: 'strafe_right', duration_ms: duration }, { kind: 'jump', duration_ms: duration }, { kind: 'turn', dx: 40, duration_ms: duration }, { kind: 'move', axis: 'forward', duration_ms: duration }];
    return { action: recovery[s.recoverAttempts++]!, conditions: [condition('navigation.recover_safe', true, p.maxAgeMs), condition('navigation.stuck', true, p.maxAgeMs)], state: 'recovering_stuck' };
  }
}
