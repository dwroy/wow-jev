import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Ajv } from 'ajv';
import { loadProtocolValidator, validateMessage, type ActionIntent, type Artifact, type ExecutionReceipt, type Observation } from '../core/protocol.js';
import { loadNativeValidator, assertNativeMessage, type NativeReceipt } from '../hand/protocol.js';
import { assertEye, loadEyeValidator, type EyeSample } from './protocol.js';
import { loadSeedValidator } from './seed.js';
import { hashFile, hashBuffer, type EyeLogRecord, type RunManifest } from './store.js';
import { EyeState, type SeedResult, type SourceImage, type TargetContext } from './state.js';
interface CombatBundle { version: number; kind: string; id: string; client_width: number; client_height: number; signature?: unknown; detectors: Record<string, { templates: Record<string, { file: string; sha256: string }[]> }> }

/** Reconstructs recorded facts only; it never launches native processes or model workers. */
export async function replayRun(directory: string): Promise<{ run_id: string; records: number; observations: number; actions: number; complete: boolean; artifacts: number; confirmed_effects: number }> {
  const dir = resolve(directory); const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as RunManifest;
  if (manifest.protocol !== 'wow-eye-run' || manifest.version !== 1 || typeof manifest.run_id !== 'string' || !manifest.schemas) throw new Error('invalid_run_manifest');
  if (hashBuffer(JSON.stringify(manifest.config)) !== manifest.config_sha256) throw new Error('config_hash_mismatch');
  for (const [name, hash] of Object.entries(manifest.schemas)) {
    if (!/^[a-z0-9.-]+\.json$/.test(name) || await hashFile(join(dir, 'schemas', name)) !== hash) throw new Error('schema_hash_mismatch');
  }
  if (manifest.calibration) for (const [name, hash] of Object.entries(manifest.calibration.files)) {
    if (!['calibration.json', 'open.png', 'closed.png'].includes(name) || await hashFile(join(dir, 'calibration', name)) !== hash) throw new Error('calibration_hash_mismatch');
  }
  const extension = manifest as RunManifest & { combat_calibration?: { id: string; files: Record<string, string> }; extra_prompts?: Record<string, { version: string; sha256: string; file: string }> };
  let combatBundle: CombatBundle | null = null;
  if (extension.combat_calibration) {
    const frozen = extension.combat_calibration;
    const folder = await lstat(join(dir, 'combat-calibration')); if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('combat_calibration_path');
    if (!frozen.files['calibration.json']) throw new Error('combat_calibration_manifest');
    for (const [name, hash] of Object.entries(frozen.files)) {
      if (name !== 'calibration.json' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.png$/.test(name) || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('combat_calibration_manifest');
      const path = join(dir, 'combat-calibration', name); const file = await lstat(path);
      if (!file.isFile() || file.isSymbolicLink() || await hashFile(path) !== hash) throw new Error('combat_calibration_hash_mismatch');
    }
    const bundle = JSON.parse(await readFile(join(dir, 'combat-calibration/calibration.json'), 'utf8')) as CombatBundle;
    if (bundle.version !== 1 || bundle.kind !== 'combat-ui' || bundle.id !== frozen.id) throw new Error('combat_calibration_id');
    const referenced = new Set(['calibration.json']);
    for (const detector of Object.values(bundle.detectors)) for (const entries of Object.values(detector.templates)) for (const template of entries) {
      if (frozen.files[template.file] !== template.sha256) throw new Error('combat_calibration_template_hash');
      referenced.add(template.file);
    }
    if (referenced.size !== Object.keys(frozen.files).length) throw new Error('combat_calibration_extra_file');
    combatBundle = bundle;
  }
  for (const prompt of Object.values(extension.extra_prompts ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(prompt.file) || !/^[0-9a-f]{64}$/.test(prompt.sha256) || !prompt.version) throw new Error('extra_prompt_manifest');
    const path = join(dir, 'prompts', prompt.file); const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || await hashFile(path) !== prompt.sha256) throw new Error('extra_prompt_hash_mismatch');
  }
  const logSchema = JSON.parse(await readFile(join(dir, 'schemas/eye-log-v1.schema.json'), 'utf8')) as object;
  const logValidator = new Ajv({ strict: true, allErrors: true }).compile<EyeLogRecord>(logSchema);
  const [agent, eye, input] = await Promise.all([
    loadProtocolValidator(join(dir, 'schemas/agent-v1.schema.json')), loadEyeValidator(join(dir, 'schemas/native-eye-v1.schema.json')),
    loadNativeValidator(join(dir, 'schemas/native-input-v1.schema.json')),
  ]);
  const seed = manifest.schemas['seed-result-v1.schema.json'] ? await loadSeedValidator(join(dir, 'schemas/seed-result-v1.schema.json')) : null;
  const logPath = join(dir, 'events.jsonl'); const info = await lstat(logPath);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error('unsafe_or_oversized_log');
  const observations = new Map<string, Observation>(); const actions = new Map<string, ActionIntent>(); const receipts = new Map<string, ExecutionReceipt>();
  const artifacts = new Map<string, Artifact>(); const samples = new Map<string, EyeSample>(); const boundaries = new Map<string, { native_id: string; started_at_ms: number; received_at_ms: number }>();
  const inputReceipts = new Map<string, NativeReceipt>(); let seq = 0; let lastAt = 0; let lastObservationSeq = -1; let complete = false; let ended = false; let confirmed = 0;
  let state: EyeState | null = null;
  const sourceContexts = new Map<string, TargetContext | undefined>();
  const linkedReceipts = new Set<string>();
  const lines = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 512 * 1024 || line.trim() === '') throw new Error('invalid_log_line');
    const parsed: unknown = JSON.parse(line);
    if (!logValidator(parsed) || parsed.run_id !== manifest.run_id || parsed.seq !== seq++ || parsed.at_ms < lastAt) throw new Error('log_sequence_or_schema');
    const record = parsed; lastAt = record.at_ms;
    if (ended) throw new Error('log_after_run_end');
    if (record.seq === 0 && (record.kind !== 'manifest' || JSON.stringify(record.data) !== JSON.stringify(manifest))) throw new Error('manifest_log_mismatch');
    if (record.kind === 'native_eye') {
      const data = record.data as { direction: 'out' | 'in'; message: unknown };
      assertEye(data.message, eye);
      if (data.direction === 'in' && data.message.type === 'ready') state = new EyeState(manifest.run_id, data.message.session_id, 'observation-0', {
        cvMaxAgeMs: Number(manifest.config.cv_max_age_ms ?? 1500), seedMaxAgeMs: Number(manifest.config.seed_max_age_ms ?? 5000),
      });
      if (data.direction === 'in' && data.message.type === 'sample') {
        for (const [key, detector] of Object.entries(data.message.detectors)) if (key !== 'inventory_open' && detector?.calibration_id) {
          if (detector.calibration_id !== extension.combat_calibration?.id || !combatBundle) throw new Error('combat_calibration_source_missing');
          if (key === 'target_signature' ? !combatBundle.signature : !combatBundle.detectors[key]) throw new Error('combat_detector_not_configured');
          if (detector.status === 'known' && (data.message.window.client_width !== combatBundle.client_width || data.message.window.client_height !== combatBundle.client_height)) throw new Error('combat_layout_mismatch_known');
        }
        samples.set(data.message.id, data.message);
      }
    } else if (record.kind === 'sample_boundary') {
      const data = record.data as { native_id: string; observation_id: string; started_at_ms: number; received_at_ms: number };
      if (!samples.has(data.native_id) || data.started_at_ms > data.received_at_ms || data.received_at_ms > record.at_ms) throw new Error('sample_boundary_invalid');
      boundaries.set(data.observation_id, data);
    } else if (record.kind === 'artifact') {
      const artifact = record.data as Artifact;
      if (artifact.kind !== 'screenshot' || typeof artifact.path !== 'string' || !artifact.path.startsWith('artifacts/') || isAbsolute(artifact.path) || artifacts.has(artifact.id)) throw new Error('artifact_metadata');
      const path = join(dir, artifact.path); const file = await lstat(path);
      const rel = relative(await realpath(join(dir, 'artifacts')), await realpath(path));
      if (!file.isFile() || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || file.size > 64 * 1024 * 1024 || await hashFile(path) !== artifact.sha256) throw new Error('artifact_hash_or_path');
      artifacts.set(artifact.id, artifact);
    } else if (record.kind === 'observation') {
      const observation = record.data as Observation; const valid = validateMessage(observation, agent);
      if (!valid.ok || observation.type !== 'observation' || observation.run_id !== manifest.run_id || observations.has(observation.id) || observation.observation_seq <= lastObservationSeq || observation.at_ms > record.at_ms) throw new Error('observation_invalid');
      for (const field of Object.values(observation.fields)) {
        if (field.source_observation_id !== observation.id && !observations.has(field.source_observation_id)) throw new Error('observation_source_missing');
        for (const id of field.artifact_ids ?? []) if (!artifacts.has(id)) throw new Error('field_artifact_missing');
        const boundary = boundaries.get(field.source_observation_id);
        if (field.capture_window && boundary && (field.captured_at_ms !== boundary.started_at_ms || field.capture_window.latest_ms !== boundary.received_at_ms)) throw new Error('source_capture_time_changed');
      }
      for (const artifact of observation.artifacts) if (!artifacts.has(artifact.id)) throw new Error('observation_artifact_missing');
      if (!state) throw new Error('observation_before_ready');
      const ownBoundary = boundaries.get(observation.id);
      if (ownBoundary) {
        const sample = samples.get(ownBoundary.native_id)!;
        const artifact = observation.artifacts[0];
        if (sample.artifact && artifact && (artifact.id !== sample.artifact.id || artifact.sha256 !== sample.artifact.sha256)) throw new Error('artifact_sample_mismatch');
        state.applySample({ sample, started_at_ms: ownBoundary.started_at_ms, received_at_ms: ownBoundary.received_at_ms }, observation.id, artifact);
      } else if (observation.fields['capture.available']?.reason?.code === 'post_capture_unavailable') {
        const field = observation.fields['capture.available']!;
        if (!field.capture_window) throw new Error('failed_capture_without_bounds');
        state.failedCapture(field.captured_at_ms, field.capture_window.latest_ms, observation.id, 'post_capture_unavailable');
      }
      const expected = state.snapshot(observation.id, observation.observation_seq, observation.at_ms, observation.artifacts);
      if (JSON.stringify(expected) !== JSON.stringify(observation)) throw new Error('observation_does_not_match_recorded_state');
      sourceContexts.set(observation.id, state.seedSourceContext().target_context);
      observations.set(observation.id, observation); lastObservationSeq = observation.observation_seq;
    } else if (record.kind === 'seed_result') {
      const data = record.data as { raw: SeedResult; source: SourceImage; adoption: unknown; adoption_at_ms: number };
      if (!seed || !seed(data.raw) || !observations.has(data.source.source_observation_id) || !artifacts.has(data.source.artifact_id)) throw new Error('seed_source_or_schema');
      const boundary = boundaries.get(data.source.source_observation_id);
      const sourceSample = boundary ? samples.get(boundary.native_id) : undefined;
      if (!boundary || boundary.started_at_ms !== data.source.captured_at_ms || boundary.received_at_ms !== data.source.received_at_ms || sourceSample?.capture.started_qpc_ms !== data.source.source_qpc_ms ||
        !observations.get(data.source.source_observation_id)!.artifacts.some((artifact) => artifact.id === data.source.artifact_id && artifact.id === sourceSample?.artifact?.id)) throw new Error('seed_source_time');
      if (JSON.stringify(data.source.target_context) !== JSON.stringify(sourceContexts.get(data.source.source_observation_id))) throw new Error('seed_source_target_context');
      if (!state || !Number.isSafeInteger(data.adoption_at_ms) || data.adoption_at_ms > record.at_ms || data.adoption_at_ms < data.source.received_at_ms) throw new Error('seed_adoption_time');
      if (JSON.stringify(state.applySeed(data.raw, data.source, data.adoption_at_ms)) !== JSON.stringify(data.adoption)) throw new Error('seed_adoption_mismatch');
    } else if (record.kind === 'action_intent') {
      const action = record.data as ActionIntent; const valid = validateMessage(action, agent);
      const before = observations.get(action.based_on_observation_id);
      if (!valid.ok || action.type !== 'action_intent' || action.run_id !== manifest.run_id || actions.has(action.id) || !before || action.window_token !== before.window?.token) throw new Error('action_source_or_schema');
      actions.set(action.id, action);
    } else if (record.kind === 'native_input') {
      const message = (record.data as { message: unknown }).message; assertNativeMessage(message, input);
      if (message.type === 'receipt' && message.op === 'execute' && message.status !== 'accepted') inputReceipts.set(message.id, message);
    } else if (record.kind === 'execution_receipt') {
      const receipt = record.data as ExecutionReceipt; const valid = validateMessage(receipt, agent);
      if (!valid.ok || receipt.type !== 'execution_receipt' || receipt.run_id !== manifest.run_id || !actions.has(receipt.action_id) || receipts.has(receipt.id)) throw new Error('execution_receipt_invalid');
      for (const id of receipt.effect.evidence_observation_ids) if (!observations.has(id)) throw new Error('effect_evidence_missing');
      receipts.set(receipt.id, receipt); if (receipt.effect.status === 'confirmed') confirmed++;
    } else if (record.kind === 'action_link') {
      const link = record.data as { action_id: string; native_receipt_id: string | null; before_observation_id: string; after_observation_id: string; receipt_id: string; received_input_at_ms: number | null };
      const receipt = receipts.get(link.receipt_id); const before = observations.get(link.before_observation_id); const after = observations.get(link.after_observation_id);
      const intent = actions.get(link.action_id);
      if (!receipt || receipt.action_id !== link.action_id || !intent || intent.based_on_observation_id !== link.before_observation_id || !before || !after ||
        linkedReceipts.has(link.receipt_id) || link.native_receipt_id !== null && (!inputReceipts.has(link.native_receipt_id) || link.native_receipt_id !== intent.id) ||
        after.at_ms < before.at_ms || link.received_input_at_ms !== receipt.timing.finished_at_ms) throw new Error('action_link_incomplete');
      linkedReceipts.add(link.receipt_id);
      if (receipt.effect.status === 'confirmed' && JSON.stringify(receipt.effect.evidence_observation_ids) !== JSON.stringify([link.before_observation_id, link.after_observation_id])) throw new Error('effect_link_evidence_mismatch');
      if (receipt.effect.status === 'confirmed') {
        const pre = before.fields['ui.inventory_open']; const post = after.fields['ui.inventory_open']; const nativeReceipt = inputReceipts.get(link.native_receipt_id!);
        const a = boundaries.get(before.id); const b = boundaries.get(after.id); const preSample = a ? samples.get(a.native_id) : undefined; const postSample = b ? samples.get(b.native_id) : undefined;
        if (pre?.status !== 'known' || post?.status !== 'known' || typeof pre.value !== 'boolean' || typeof post.value !== 'boolean' || pre.value === post.value || pre.source !== 'cv' || post.source !== 'cv' ||
          link.received_input_at_ms === null || post.captured_at_ms < link.received_input_at_ms || before.window?.token !== after.window?.token || !nativeReceipt || nativeReceipt.status !== 'completed' ||
          !nativeReceipt.input.released || nativeReceipt.input.events_requested < 1 || nativeReceipt.input.events_inserted !== nativeReceipt.input.events_requested ||
          !preSample?.detectors.inventory_open.calibration_id || preSample.detectors.inventory_open.calibration_id !== postSample?.detectors.inventory_open.calibration_id) throw new Error('unsupported_effect_confirmation');
        if (preSample.capture.status !== 'ok' || postSample?.capture.status !== 'ok' || preSample.detectors.inventory_open.status !== 'known' || postSample.detectors.inventory_open.status !== 'known' ||
          preSample.detectors.inventory_open.value !== pre.value || postSample.detectors.inventory_open.value !== post.value || pre.source_observation_id !== before.id || post.source_observation_id !== after.id ||
          !before.artifacts.some((artifact) => artifact.id === preSample.artifact?.id) || !after.artifacts.some((artifact) => artifact.id === postSample.artifact?.id)) throw new Error('raw_cv_effect_evidence_mismatch');
      }
    } else if (record.kind === 'run_end') { complete = (record.data as { status?: string }).status === 'complete'; ended = true; }
  }
  if (receipts.size !== linkedReceipts.size || complete && actions.size !== receipts.size) throw new Error('missing_action_link_or_receipt');
  return { run_id: manifest.run_id, records: seq, observations: observations.size, actions: actions.size, complete, artifacts: artifacts.size, confirmed_effects: confirmed };
}
