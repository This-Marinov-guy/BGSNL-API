export class JobTimeoutError extends Error {
  constructor() {
    super("Background job attempt timed out");
    this.name = "JobTimeoutError";
    this.code = "JOB_TIMEOUT";
  }
}

// The signal prevents deferred work from starting after the deadline. Database
// operations also need their own server-side limit; Promise.race cannot cancel I/O.
export async function withJobTimeout(work, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new JobTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
