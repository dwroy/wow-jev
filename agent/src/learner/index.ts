import type { ExecutionReceipt, Observation } from '../core/protocol.js';
import type { EyeLogRecord } from '../eye/store.js';
import type { SkillResult } from '../play/types.js';
import type { EvidenceRef, KnowledgeFact, KnowledgeSource } from '../system/types.js';
import { assertKnowledgeSnapshot, canonicalJson, createKnowledgeSnapshot, fail, object, sha256, type Scalar } from '../knowledge/validation.js';
import { assertEvidenceBound, recordEvidence, targetSampleIdentity, verifyAnyLearningRun, type VerifiedRun } from './source.js';
import { layerRecordEvidence } from './layers-source.js';
import { layerSample, layerSlices } from './layers.js';
import type { LearnRunsOptions, LearningResult, LearningSlice, ReviewDraft } from './types.js';
export { verifyKnowledgeEvidence, verifyLearningRun, verifyAnyLearningRun } from './source.js';
export type { LearnRunsOptions, LearningResult, LearningSlice, ReviewDraft } from './types.js';

type Descriptor = Pick<KnowledgeFact, 'kind' | 'certainty' | 'statement' | 'scope'>;
const movement = new Set(['move_for', 'turn_for', 'jump']);
function descriptorId(descriptor: Descriptor): string { return `fact-${sha256(canonicalJson(descriptor))}`; }
function layout(observation?: Observation): string | null { return observation?.window ? `${observation.window.client_width}x${observation.window.client_height}` : null; }
function status(run: VerifiedRun): string {
  const end = run.records.find((row) => row.kind === 'run_end')?.data as { status?: string } | undefined;
  return end?.status ?? 'incomplete';
}
function slices(run: VerifiedRun): LearningSlice[] {
  const result: LearningSlice[] = []; const last = run.records.at(-1)!.seq;
  const goal = object(run.manifest.config.brain_goal) ? run.manifest.config.brain_goal : object(run.manifest.config.jev_goal) ? run.manifest.config.jev_goal : null;
  result.push({ id: `slice-${sha256(`${run.source.id}:task`)}`, source_id: run.source.id, kind: 'task', start_seq: 0, end_seq: last,
    journal_status: status(run), identity: { task_kind: 'recorded_run_goal', goal_id: typeof goal?.id === 'string' ? goal.id : null, in_game_quest_completed: null }, evidence: [] });
  let plan: LearningSlice | null = null; let encounter: LearningSlice | null = null;
  for (const row of run.records) {
    if (row.kind === 'event') {
      const event = row.data as Record<string, unknown>;
      if (event.code === 'play.plan_started' && object(event.plan)) {
        plan = { id: `slice-${sha256(`${run.source.id}:plan:${row.seq}`)}`, source_id: run.source.id, kind: 'plan', start_seq: row.seq, end_seq: last,
          journal_status: 'incomplete', identity: { plan_id: String(event.plan.id), plan_revision: Number(event.plan.revision) }, evidence: [] }; result.push(plan);
      } else if (event.code === 'play.plan_finished' && plan && object(event.result)) {
        plan.end_seq = row.seq; plan.journal_status = String(event.result.status); plan = null;
      }
    }
    if (row.kind !== 'observation') continue;
    const observation = row.data as Observation; const present = observation.fields['target.present']; const signature = observation.fields['target.signature'];
    const ui = signature?.status === 'known' && typeof signature.value === 'string' ? signature.value : null;
    const name = observation.fields['target.name']; const reportedName = name?.status === 'known' && typeof name.value === 'string' ? name.value : null;
    if (encounter && (present?.status !== 'known' || present.value !== true || ui !== encounter.identity.target_ui_signature ||
      reportedName !== null && encounter.identity.reported_ui_name !== null && reportedName !== encounter.identity.reported_ui_name)) {
      encounter.end_seq = row.seq; encounter.journal_status = present?.status === 'known' && present.value === false ? 'target_ui_lost' : 'target_ui_unknown_or_changed'; encounter = null;
    }
    if (present?.status === 'known' && present.value === true && !encounter) {
      encounter = { id: `slice-${sha256(`${run.source.id}:target:${row.seq}`)}`, source_id: run.source.id, kind: 'target_encounter', start_seq: row.seq, end_seq: last,
        journal_status: 'visible_at_log_end', identity: { identity_kind: ui ? 'ui_signature' : 'visible_presence_segment', target_ui_signature: ui,
          reported_ui_name: reportedName, entity_guid: null, killed: null }, evidence: [] }; result.push(encounter);
    }
    if (encounter) { encounter.identity.reported_ui_name ??= reportedName; encounter.evidence.push(recordEvidence(run, row)); }
  }
  return result;
}

/** Deterministic evidence extraction. It invokes no model, native process, credential reader or input module. */
export async function learnRuns(runDirectories: readonly string[], options: LearnRunsOptions = {}): Promise<LearningResult> {
  if (!Array.isArray(runDirectories) || runDirectories.length > 10000 || runDirectories.some((path) => typeof path !== 'string')) fail('run_directories');
  if (options.previous) assertKnowledgeSnapshot(options.previous);
  const sources = new Map<string, KnowledgeSource>((options.previous?.sources ?? []).map((source) => [source.id, structuredClone(source)]));
  const facts = new Map<string, KnowledgeFact>((options.previous?.facts ?? []).map((fact) => [fact.id, structuredClone(fact)]));
  const resultSlices: LearningSlice[] = []; const duplicates: string[] = []; const created = [options.previous?.created_at].filter((value): value is string => !!value);
  function sample(descriptor: Descriptor, ref: EvidenceRef, counterexample: boolean, metrics: Record<string, Scalar>): void {
    const id = descriptorId(descriptor); let fact = facts.get(id);
    if (!fact) { fact = { ...descriptor, id, sample_count: 0, counterexamples: 0, evidence: [], metrics: {} }; facts.set(id, fact); }
    if (fact.evidence.some((item) => item.source_id === ref.source_id && item.record_seq === ref.record_seq)) return;
    fact.sample_count++; if (counterexample) fact.counterexamples++; fact.evidence.push(ref);
    for (const [key, value] of Object.entries(metrics)) {
      const before = fact.metrics[key];
      if (typeof value === 'number' && key.endsWith('_count')) fact.metrics[key] = Number(before ?? 0) + value;
      else if (before !== undefined && before !== value) fail('metric_scope_conflict');
      else fact.metrics[key] = value;
    }
  }
  for (const directory of runDirectories) {
    const run = await verifyAnyLearningRun(directory); const old = [...sources.values()].find((source) => source.run_id === run.source.run_id || source.events_sha256 === run.source.events_sha256);
    if (old) {
      if (canonicalJson(old) !== canonicalJson(run.source)) fail('conflicting_run_identity');
      duplicates.push(old.id); continue;
    }
    sources.set(run.source.id, run.source);
    if (run.format === 'layers') {
      created.push(new Date(run.manifest.started_at).toISOString()); resultSlices.push(...layerSlices(run));
      for (const row of run.records) {
        const derived = layerSample(run, row); if (!derived) continue;
        sample(derived.descriptor, layerRecordEvidence(run, row), derived.counterexample, derived.metrics);
      }
      continue;
    }
    created.push(run.manifest.created_at); resultSlices.push(...slices(run));
    const legacyRun: VerifiedRun = run;
    const consumedReceipts = new Set<string>();
    function outcome(row: EyeLogRecord, skill: string, receipt: ExecutionReceipt | null, beforeId: string | null, afterId: string | null, outcomeStatus: string): void {
      const run = legacyRun;
      const before = beforeId ? run.observations.get(beforeId) : undefined; const after = afterId ? run.observations.get(afterId) : undefined;
      const ref = recordEvidence(run, row); assertEvidenceBound(run, ref);
      if (receipt) consumedReceipts.add(receipt.id);
      const effect = receipt?.effect.status ?? (outcomeStatus === 'already_satisfied' ? 'already_satisfied' : 'no_receipt');
      const counterexample = ['unknown', 'pending', 'failed', 'no_receipt'].includes(effect) || ['failed', 'rejected', 'cancelled'].includes(outcomeStatus) || ['partial', 'failed', 'cancelled', 'rejected'].includes(receipt?.input.status ?? '');
      const scope: Record<string, Scalar> = { mode: run.source.mode, skill, layout: layout(before ?? after), journal_complete: run.source.complete,
        test_target: typeof run.manifest.config.test_target === 'boolean' ? run.manifest.config.test_target : null };
      const metrics: Record<string, Scalar> = {
        confirmed_effect_count: effect === 'confirmed' ? 1 : 0, effect_unknown_count: ['unknown', 'pending', 'no_receipt'].includes(effect) ? 1 : 0,
        failed_effect_count: effect === 'failed' ? 1 : 0, failed_or_rejected_step_count: ['failed', 'rejected'].includes(outcomeStatus) ? 1 : 0,
        cancelled_step_count: outcomeStatus === 'cancelled' ? 1 : 0, already_satisfied_count: outcomeStatus === 'already_satisfied' ? 1 : 0,
        partial_input_count: receipt?.input.status === 'partial' ? 1 : 0,
        released_input_count: receipt?.input.status === 'released' ? 1 : 0, simulated_input_count: receipt?.input.status === 'simulated' ? 1 : 0,
        game_success_inferred_from_input: false,
      };
      const panel = skill === 'open_panel' || skill === 'close_panel' || skill === 'inventory_toggle';
      if (panel) { scope.panel = 'inventory'; scope.calibration_id = run.manifest.calibration?.id ?? null; }
      sample({ kind: 'experience', certainty: 'observed', scope,
        statement: run.source.mode === 'simulated' ? '模拟技能日志只证明编排结果，不能作为游戏效果或游戏事实。' : movement.has(skill) ?
          '此布局中的运动技能游戏效果未得到确认；完整输入回执不能证明到达、转向完成或击杀。' : '此技能的输入、观察效果与失败反例分别记录；步骤完成不能代替游戏效果确认。' }, ref, counterexample, metrics);
      if (run.source.mode === 'live' && movement.has(skill) && effect !== 'confirmed') {
        sample({ kind: 'experience', certainty: 'inferred', scope,
          statement: '在缺少到达观察证据时，建议等待或升级感知；该建议不授权动作，也不证明运动失败。' }, ref, true,
          { requires_arrival_evidence: true, avoid_movement: true, recommended_wait_ms: 250, effect_unknown_count: Number(metrics.effect_unknown_count), authorizes_actions: false });
      }
      if (run.source.mode === 'live' && run.manifest.config.test_target !== true && panel && effect === 'confirmed') {
        const post = after?.fields['ui.inventory_open']; const pre = before?.fields['ui.inventory_open'];
        if (pre?.status !== 'known' || post?.status !== 'known' || typeof post.value !== 'boolean' || pre.value === post.value || !ref.artifact_ids.length || receipt?.effect.evidence_observation_ids.length !== 2) fail('unconfirmed_game_fact');
        sample({ kind: 'game_fact', certainty: 'observed', scope: { ...scope, goal_kind: 'panel_cycle', inventory_open_after: post.value },
          statement: '已校验源截图、校准 CV 与前后观察的背包开闭变化；只适用于记录的技能与布局。' }, ref, false,
          { confirmed_transition_count: 1, inventory_open_after: post.value, input_only_is_success: false });
      }
    }
    for (const row of run.records) {
      if (row.kind !== 'event') continue;
      const event = row.data as { code?: string; result?: SkillResult };
      if (event.code === 'play.step_result' && event.result) outcome(row, event.result.skill, event.result.receipt, event.result.before_observation_id, event.result.after_observation_id, event.result.status);
    }
    for (const row of run.records) {
      if (row.kind !== 'execution_receipt') continue; const receipt = row.data as ExecutionReceipt; if (consumedReceipts.has(receipt.id)) continue;
      const link = run.records.find((item) => item.kind === 'action_link' && (item.data as { receipt_id?: string }).receipt_id === receipt.id)?.data as { before_observation_id?: string; after_observation_id?: string } | undefined;
      outcome(row, receipt.effect.status === 'confirmed' ? 'inventory_toggle' : 'native_input', receipt, link?.before_observation_id ?? null, link?.after_observation_id ?? null, receipt.input.status);
    }
    const seenTargetSources = new Set<string>(); const seenReportedNames = new Set<string>();
    for (const row of run.records) {
      if (row.kind !== 'observation' || run.source.mode !== 'live' || run.manifest.config.test_target === true) continue;
      const observation = row.data as Observation; const name = observation.fields['target.name']; const present = observation.fields['target.present'];
      const targetSample = targetSampleIdentity(observation);
      if (name?.status !== 'known' || typeof name.value !== 'string' || !name.value || present?.status !== 'known' || present.value !== true || seenTargetSources.has(targetSample)) continue;
      const ref = recordEvidence(run, row); if (!ref.artifact_ids.length) continue; assertEvidenceBound(run, ref); seenTargetSources.add(targetSample);
      const dead = observation.fields['target.dead'];
      sample({ kind: 'monster_statistic', certainty: 'observed', scope: { mode: 'live', layout: layout(observation), skill: null, target_name: name.value, journal_complete: run.source.complete, name_source: name.source },
        statement: '记录可见目标栏报告的名字与观察状态；名字和 UI 指纹都不等于实体 GUID，死亡读数不证明击杀。' }, ref, dead?.status !== 'known',
        { target_ui_observation_count: 1, reported_name_observation_count: seenReportedNames.has(name.source_observation_id) ? 0 : 1, death_ui_true_count: dead?.status === 'known' && dead.value === true ? 1 : 0,
          death_ui_unknown_count: dead?.status !== 'known' ? 1 : 0, identity_kind: 'reported_ui_name', name_source: name.source,
          entity_guid: null, distinct_entities: null, kill_count: null, level: null, loot_rate: null });
      seenReportedNames.add(name.source_observation_id);
    }
  }
  for (const fact of facts.values()) fact.evidence.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.record_seq - b.record_seq);
  const snapshot = createKnowledgeSnapshot([...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), [...facts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    options.createdAt ?? created.sort().at(-1) ?? '1970-01-01T00:00:00.000Z', options.previous?.schema_version === 2 || [...sources.values()].some(s => s.kind === 'layers') ? 2 : 1);
  const reviews: ReviewDraft[] = snapshot.facts.filter((fact) => fact.certainty === 'observed' && (fact.counterexamples > 0 || fact.scope.mode === 'simulated')).map((fact) => {
    const simulated = fact.scope.mode === 'simulated'; const unknown = Number(fact.metrics.effect_unknown_count ?? 0) > 0;
    return { id: `review-${sha256(fact.id)}`, category: simulated ? 'simulated_only' : unknown ? 'unverified_effect' : 'counterexample', certainty: 'inferred',
      finding: simulated ? '只有模拟编排证据。' : unknown ? '输入回执与游戏效果未确认同时存在。' : '失败、拒绝或部分输入反例需要保留。',
      suggestion: simulated ? '补真实场景证据后再讨论游戏收益。' : unknown ? '收紧复盘题面：不能把输入已发出解释成到达或击杀。' : '复核失败来源和适用布局，提案须独立测试。', fact_ids: [fact.id], evidence: structuredClone(fact.evidence) };
  });
  for (const source of snapshot.sources.filter((item) => !item.complete)) {
    const refs = snapshot.facts.flatMap((fact) => fact.evidence.filter((ref) => ref.source_id === source.id));
    const unique = [...new Map(refs.map((ref) => [ref.record_seq, ref])).values()];
    reviews.push({ id: `review-${sha256(`${source.id}:incomplete`)}`, category: 'incomplete_run', finding: '来源运行未完成，合法失败及反例仍保留。',
      suggestion: '不能把运行未完成或目标栏丢失解释成任务完成或目标死亡。', certainty: 'inferred', fact_ids: snapshot.facts.filter((fact) => fact.evidence.some((ref) => ref.source_id === source.id)).map((fact) => fact.id), evidence: unique });
  }
  return { snapshot, slices: resultSlices, reviews, duplicate_sources: [...new Set(duplicates)] };
}
