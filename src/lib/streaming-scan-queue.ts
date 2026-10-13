/** A bounded consumer that stays open while discovery can still produce work. */
export function createStreamingScanQueue<T>(options: {
  concurrency: number;
  signal: AbortSignal;
  scan: (candidate: string, signal: AbortSignal) => Promise<T | undefined>;
  onResult: (result: T) => void;
  onSkipped?: (candidate: string) => void;
}) {
  const checkConcurrency = (value: number) => {
    if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError("Scan concurrency must be an integer between 1 and 8");
  };
  checkConcurrency(options.concurrency);
  const controller = new AbortController();
  const candidates: { candidate: string; priority: number }[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let active = 0;
  let concurrency = options.concurrency;
  let sealed = false;
  let settled = false;
  let failed = false;
  let failure: unknown;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Discovery may still be running when a worker fails; retain the failure for done().
  void completion.catch(() => {});
  const stop = () => {
    if (!failed) { failed = true; failure = options.signal.reason ?? new DOMException("Aborted", "AbortError"); }
    controller.abort(failure);
    finish();
  };
  options.signal.addEventListener("abort", stop, { once: true });

  function finish() {
    if (settled || active || !failed && (!sealed || offset < candidates.length)) return;
    settled = true;
    options.signal.removeEventListener("abort", stop);
    if (failed) reject(failure);
    else resolve();
  }
  function pump() {
    while (!failed && !settled && active < concurrency && offset < candidates.length) {
      const { candidate } = candidates[offset++];
      active += 1;
      void Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        let stopRequest!: () => void;
        const cancellation = new Promise<never>((_resolve, reject) => {
          stopRequest = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", stopRequest, { once: true });
        });
        try { return await Promise.race([options.scan(candidate, controller.signal), cancellation]); }
        finally { controller.signal.removeEventListener("abort", stopRequest); }
      }).then(result => {
        if (failed || controller.signal.aborted) return;
        if (result === undefined) {
          seen.delete(candidate);
          options.onSkipped?.(candidate);
        } else options.onResult(result);
      }).catch(error => {
        if (!failed) { failed = true; failure = error; controller.abort(error); }
      }).finally(() => {
        active -= 1;
        pump();
        finish();
      });
    }
    finish();
  }
  if (options.signal.aborted) stop();
  return {
    add(candidate: string, priority = 0) {
      if (settled || failed) return;
      if (seen.has(candidate)) {
        const pending = candidates.findIndex((job, index) => index >= offset && job.candidate === candidate);
        if (pending < 0 || candidates[pending].priority >= priority) return;
        candidates.splice(pending, 1);
      }
      seen.add(candidate);
      let position = offset;
      while (position < candidates.length && candidates[position].priority >= priority) position += 1;
      candidates.splice(position, 0, { candidate, priority });
      pump();
    },
    setConcurrency(value: number) {
      checkConcurrency(value);
      concurrency = value;
      pump();
    },
    done() {
      sealed = true;
      finish();
      return completion;
    },
    cancel() {
      if (!settled) {
        if (!failed) { failed = true; failure = new DOMException("Aborted", "AbortError"); }
        controller.abort(failure);
        finish();
      }
      return completion.catch(() => {});
    }
  };
}
