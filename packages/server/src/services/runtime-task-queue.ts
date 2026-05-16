export type RuntimeTask = () => Promise<void>;

export interface RuntimeTaskQueue {
  enqueue(task: RuntimeTask): void;
  idle(): Promise<void>;
}

export function createRuntimeTaskQueue(): RuntimeTaskQueue {
  let chain: Promise<void> = Promise.resolve();

  return {
    enqueue(task) {
      chain = chain.then(task).catch(() => undefined);
    },
    idle() {
      return chain;
    },
  };
}
