import type { ActionCondition, JsonValue, Observation } from '../core/protocol.js';
import type { BehaviorPorts, BehaviorResult, BehaviorSpec, BodyAction, ExecutionContext, MovementAxis } from '../layers/contracts.js';
import { RunLease, cleanupBound } from './lease.js';
import { bindingError, conditionError, validateConditions, hash, observationError, readKnown, validateBehavior, value, type FieldPolicy } from './validation.js';

export interface BehaviorExecutionResult extends BehaviorResult { input_count_scope: 'known' | 'lower_bound'; scenario_effect: 'confirmed' | 'unverified'; }
export interface BehaviorOptions { maxFieldAgeMs?: number; maxObservationAgeMs?: number; trustedSources?: ReadonlyArray<string>; maxEffectFieldAgeMs?: number; }
export interface BehaviorRunOptions { isCurrent?: () => boolean; }
type Decision = { action: BodyAction; conditions: ActionCondition[]; state: string } | { status: BehaviorResult['status']; reason: string; effect?: boolean };
interface State { initialAlive: boolean; killActionAt?: number; killActionObservation?: string; lastActionAt?: number; lastActionObservation?: string; initialProgress?: number; lastProgress?: number; noProgress: number; recoverAttempts: number; safeFrames: number; lastSafeId?: string; rewardSelected: boolean; }
const finish = (status: BehaviorResult['status'], reason: string, effect = false): Decision => ({ status, reason, effect });
const condition = (field: string, v: JsonValue, age: number): ActionCondition => ({ field, op: 'eq', value: v, max_age_ms: age });
const axes = new Set<MovementAxis>(['forward', 'backward', 'strafe_left', 'strafe_right']);

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
    return { id: spec.id, kind: spec.kind, status, reason, input_count_scope: 'known', actions: 0, real_inputs: 0, game_effect: 'unverified', scenario_effect: 'unverified', release: 'unconfirmed', evidence_observation_ids: [] };
  }
  policy(context: Pick<ExecutionContext, 'mode'>): FieldPolicy {
    return { mode: context.mode, now: this.ports.now(), maxAgeMs: this.options.maxFieldAgeMs ?? 1000, ...(this.options.trustedSources ? { trustedSources: this.options.trustedSources } : {}) };
  }
  private async execute(spec: BehaviorSpec, context: ExecutionContext, options: BehaviorRunOptions): Promise<BehaviorExecutionResult> {
    const result = this.empty(spec, 'failed', 'behavior_exception'); const started = this.ports.now();
    const lease = new RunLease(context.signal, spec.max_duration_ms, () => this.ports.now(), options.isCurrent);
    context = { ...context, signal: lease.signal };
    const state: State = { initialAlive: false, noProgress: 0, recoverAttempts: 0, safeFrames: 0, rewardSelected: false };
    let runId: string | undefined; let previous: Observation | undefined; let initialWindow: string | undefined;
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
        const confirmingTalk = spec.kind === 'talk_to' && state.lastActionAt !== undefined;
        // A slow, independently captured dialog result can only terminate talk_to.
        // It never supplies a new action, hazard movement or a refreshed input frame.
        const effectPolicy = { ...policy, maxAgeMs: this.options.maxEffectFieldAgeMs ?? policy.maxAgeMs };
        const invalid = observationError(o, { ...policy, maxAgeMs: confirmingTalk ? effectPolicy.maxAgeMs : this.options.maxObservationAgeMs ?? 1000 }, runId) ??
          (confirmingTalk && (o.at_ms > policy.now || policy.now - o.at_ms > (this.options.maxObservationAgeMs ?? 1000)) ? 'observation_stale_or_future' : null) ??
          (confirmingTalk && context.mode === 'live' && (readKnown(o, 'window.focused', effectPolicy, true, state.lastActionAt)?.source !== 'window' || readKnown(o, 'window.focused', effectPolicy, true, state.lastActionAt)?.value !== true) ? 'post_effect_foreground_evidence_unknown' : null) ??
          conditionError(o, context.conditions, policy) ?? (confirmingTalk ? null : bindingError(spec, o, policy));
        if (invalid) { result.status = 'blocked'; result.reason = invalid; break; }
        if (previous && (o.id === previous.id || o.observation_seq <= previous.observation_seq || o.at_ms < previous.at_ms)) { result.status = 'blocked'; result.reason = 'observation_not_new'; break; }
        const windowId = o.window ? `${o.window.token}:${o.window.hwnd}:${o.window.pid}:${o.window.client_width}:${o.window.client_height}` : undefined;
        if (context.mode === 'live' && initialWindow !== undefined && initialWindow !== windowId) { result.status = 'blocked'; result.reason = 'window_binding_changed'; break; }
        initialWindow ??= windowId; runId ??= o.run_id; previous = o;
        result.evidence_observation_ids.push(o.id);
        let decision: Decision;
        const hazardous = value(o, 'hazard.active', policy, true) === true;
        if (confirmingTalk) {
          const target = readKnown(o, 'target.signature', effectPolicy, true, state.lastActionAt);
          const open = readKnown(o, 'dialog.open', effectPolicy, true, state.lastActionAt);
          const dialogTarget = readKnown(o, 'dialog.target_signature', effectPolicy, true, state.lastActionAt);
          if (hazardous) decision = finish('blocked', 'post_action_hazard_observed');
          else if (target?.value !== spec.params.target_signature || open?.value !== true || dialogTarget?.value !== spec.params.target_signature) decision = finish('blocked', 'dialog_effect_not_new_or_unconfirmed');
          else decision = finish('completed', 'dialog_open_confirmed', true);
        } else if (hazardous && spec.kind !== 'avoid_hazard') {
          const released = await lease.wait(() => this.ports.release('hazard_preempt'));
          if (released !== 'confirmed') { outcomeUnconfirmed = true; result.status = 'blocked'; result.reason = 'hazard_release_unconfirmed'; break; }
          decision = this.avoid(o, policy, state, 200, 1, false);
          await lease.wait(() => this.ports.append('behavior_hazard_preempt', { behavior_id: spec.id, observation_id: o.id }));
        } else decision = this.decide(spec, o, policy, state);
        await lease.wait(() => this.ports.append('behavior_state', { behavior_id: spec.id, observation_id: o.id, state: 'action' in decision ? decision.state : decision.reason, actions: result.actions, task_revision: context.task_revision, run_epoch: context.run_epoch }));
        if ('status' in decision) {
          result.status = decision.status; result.reason = decision.reason; result.game_effect = decision.effect ? 'confirmed' : 'unverified'; break;
        }
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
        if (decision.action.kind !== 'wait') { state.lastActionAt = out.finished_at_ms; state.lastActionObservation = o.id; }
        if (decision.action.kind === 'cast' && spec.kind === 'kill_target') { state.killActionAt = out.finished_at_ms; state.killActionObservation = o.id; }
      }
    } catch (error) {
      if (dispatched) { result.input_count_scope = 'lower_bound'; result.actions++; }
      result.status = lease.signal.reason === 'deadline' ? 'blocked' : lease.signal.aborted ? 'cancelled' : 'failed'; result.reason = error instanceof Error ? error.message : 'behavior_exception'; result.game_effect = 'unverified';
    } finally {
      try { const released = await cleanupBound(this.ports.release(result.reason)); result.release = released === 'confirmed' && !outcomeUnconfirmed ? 'confirmed' : 'unconfirmed'; }
      catch { result.release = 'unconfirmed'; }
      if (result.release !== 'confirmed' && result.status === 'completed') { result.status = 'blocked'; result.reason = 'behavior_release_unconfirmed'; result.game_effect = 'unverified'; }
      if (context.mode === 'simulated') { result.scenario_effect = result.game_effect; result.game_effect = 'unverified'; }
      try { await cleanupBound(this.ports.append('behavior_result', { ...result, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, mode: context.mode })); }
      catch { result.status = 'failed'; result.reason = 'behavior_result_log_failed'; result.game_effect = 'unverified'; result.scenario_effect = 'unverified'; }
      lease.close();
    }
    return result;
  }
  private decide(spec: BehaviorSpec, o: Observation, p: FieldPolicy, s: State): Decision {
    const duration = Number(spec.params.action_duration_ms ?? spec.params.step_duration_ms ?? 200);
    if (spec.kind === 'kill_target') return this.kill(spec, o, p, s, duration);
    if (spec.kind === 'loot_target') return this.loot(spec, o, p, s, duration);
    if (['talk_to', 'accept_quest', 'turn_in_quest'].includes(spec.kind)) return this.dialog(spec, o, p, s, duration);
    if (spec.kind === 'move_to' || spec.kind === 'fly_to') return this.navigate(spec, o, p, s, duration);
    if (spec.kind === 'avoid_hazard') return this.avoid(o, p, s, duration, Number(spec.params.safe_observations ?? 2), true);
    return this.recover(spec, o, p, s, duration);
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
