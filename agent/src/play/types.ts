import type { ActionCondition, ExecutionReceipt, Observation } from '../core/protocol.js';
import type { Collected } from '../eye/runtime.js';
import type { NativeAction, NativeReady, NativeReceipt } from '../hand/protocol.js';
import type { LogKind } from '../eye/store.js';

export type SkillStep = { id: string } & (
  | { name: 'move_for'; duration_ms: number }
  | { name: 'turn_for'; dx: number; duration_ms: number }
  | { name: 'jump'; duration_ms: number }
  | { name: 'open_panel' | 'close_panel'; panel: 'inventory' }
  | { name: 'use_action_slot'; slot: string; duration_ms: number }
  | { name: 'wait'; duration_ms: number }
);
export interface SkillBindings {
  forward: string;
  jump: string;
  inventory: string;
  action_slots: Record<string, string>;
}
export interface PlayPlan { id: string; revision: number; steps: SkillStep[] }
export interface CompiledSkill {
  action: NativeAction | null;
  conditions: ActionCondition[];
  effect: { kind: 'inventory'; desired: boolean; calibration_id: string } | { kind: 'unverified' } | { kind: 'wait'; duration_ms: number };
}
export interface PlayHand {
  readonly ready: NativeReady | null;
  execute(action: NativeAction, options?: { id?: string; timeoutMs?: number }): Promise<NativeReceipt>;
  cancel(): Promise<NativeReceipt>;
  releaseAll(): Promise<NativeReceipt>;
}
export interface PlayPorts {
  now(): number;
  collect(save: boolean): Promise<Collected>;
  append(kind: LogKind, data: unknown, at: number): Promise<void>;
  compile(step: SkillStep, before: Collected): CompiledSkill;
  hand?: PlayHand;
}
export interface PlayOptions {
  runId: string;
  mode: 'simulated' | 'live';
  maxRunMs?: number;
  maxObservationAgeMs?: number;
  effectWaitMs?: number;
  effectPollMs?: number;
  actor?: 'code' | 'jev';
  decisionId?: string;
}
export interface SkillResult {
  step_id: string;
  skill: SkillStep['name'];
  status: 'completed' | 'already_satisfied' | 'rejected' | 'cancelled' | 'failed';
  action_id: string | null;
  receipt: ExecutionReceipt | null;
  before_observation_id: string | null;
  after_observation_id: string | null;
  reason?: string;
}
export interface PlayResult {
  plan: { id: string; revision: number };
  status: 'completed' | 'cancelled' | 'failed';
  steps: SkillResult[];
  reason?: string;
}
export interface PlayStatus {
  state: 'idle' | 'running' | 'stopped';
  cancelled: boolean;
  plan: { id: string; revision: number } | null;
}
export type GateDecision = { ok: true } | { ok: false; reason: string };
export type EffectCheck = { confirmed: boolean; observation: Observation };
