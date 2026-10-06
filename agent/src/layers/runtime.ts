import type { Observation } from '../core/protocol.js';
import { createHash } from 'node:crypto';
import type { Collected } from '../eye/runtime.js';
import { cloneCollectedForRuntime } from '../eye/memory-frame.js';
import { BodyRuntime, type BodyRuntimeOptions } from '../actions/runtime.js';
import { BehaviorRuntime, type BehaviorOptions } from '../behavior/runtime.js';
import { BehaviorJev } from '../behavior/jev.js';
import { TaskRuntime, type TaskContext, type TaskRunOptions } from '../tasks/runtime.js';
import type { BehaviorChooser, BehaviorPorts, LayerTaskSpec } from './contracts.js';
import type { BodyOutcome } from './contracts.js';

/** One scheduler and one observation lineage across L4 → L3 → L2 → L1. */
export function createLayerExecution(options: BodyRuntimeOptions & {
  append: (kind: string, data: unknown) => Promise<void>;
  behaviorPolicy?: BehaviorOptions; chooser?: BehaviorChooser;
  /** Optional low-frequency independent post-action evidence. Perception still has no input capability. */
  collectEffect?: () => Promise<Collected>;
}) {
  const retained = new Map<string, Collected>();
  let suppliedBefore: Collected | null = null;
  let active = false;
  let activeWork:Promise<BodyOutcome>|null=null;
  let effectPending = false;
  const collect = async (): Promise<Collected> => {
    const effect = effectPending && options.collectEffect !== undefined; effectPending = false;
    const collected = effect ? await options.collectEffect!() : await options.collect(options.saveObservations ?? true);
    retained.set(collected.observation.id, cloneCollectedForRuntime(collected));
    while (retained.size > 64) retained.delete(retained.keys().next().value!);
    return collected;
  };
  const body = new BodyRuntime({ ...options, collect: async () => {
    if (suppliedBefore) { const before = suppliedBefore; suppliedBefore = null; return before; }
    return collect();
  } });
  const ports: BehaviorPorts = {
    now: options.now, observe: async () => (await collect()).observation,
    append: options.append ?? (async () => {}), release: reason => body.release(reason),
    executeBody: async (action, basedOn: Observation, context) => {
      const before = retained.get(basedOn.id);
      if (!before || JSON.stringify(before.observation) !== JSON.stringify(basedOn)) throw new Error('layer_observation_not_retained_or_changed');
      if (active) throw new Error('layer_body_dispatch_in_flight');
      active = true; suppliedBefore = before;
      const commandId = `body-${createHash('sha256').update(JSON.stringify([context.task_id, context.task_revision, context.run_epoch, context.command_id])).digest('hex')}`;
      try {
        await options.append('layer_command_link', { parent_command_id: context.command_id, body_command_id: commandId, task_id: context.task_id, task_revision: context.task_revision, run_epoch: context.run_epoch, based_on_observation_id: basedOn.id });
        activeWork=body.execute(action, { ...context, command_id: commandId });
        const outcome = await activeWork;
        effectPending = options.collectEffect !== undefined && outcome.status === 'completed' && action.kind !== 'wait';
        return outcome;
      }
      finally { suppliedBefore = null; active = false; activeWork=null; }
    },
  };
  const behaviors = new BehaviorRuntime(ports, options.behaviorPolicy);
  const jev = new BehaviorJev(ports, options.chooser, options.behaviorPolicy);
  const tasks = new TaskRuntime(ports, behaviors, jev);
  return { body, behaviors, jev, tasks, ports,
    drain:async()=>{if(!activeWork)return;let timer:ReturnType<typeof setTimeout>;await Promise.race([activeWork,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('layer_body_drain_timeout')),10000);})]).finally(()=>clearTimeout(timer));},
    run: (task: LayerTaskSpec, context: TaskContext, runOptions: TaskRunOptions = {}) => tasks.run(task, context, runOptions) };
}
