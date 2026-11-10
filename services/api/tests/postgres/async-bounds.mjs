export function observeTask(task) {
  // Attach immediately, even if another assertion/barrier fails before await.
  task.catch(() => {});
  return task;
}

export async function withDeadline(task, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function barrierOrCompletion(ready, task, milliseconds = 3000) {
  const premature = task.then(
    () => { throw new Error('Task completed before reaching barrier'); },
    error => { throw error; },
  );
  return withDeadline(Promise.race([ready, premature]), milliseconds, 'Barrier readiness');
}

export function settleBounded(tasks, milliseconds = 10000) {
  return withDeadline(Promise.allSettled(tasks), milliseconds, 'Pending task cleanup');
}
