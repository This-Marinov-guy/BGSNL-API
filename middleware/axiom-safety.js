export function reportAxiomFailure() {
  try {
    console.error("[axiom] logging failed; application processing is unchanged");
  } catch { /* The fallback sink must never break application work. */ }
}

/** Guard both synchronous preparation and asynchronous SDK failures. */
export function bestEffortLog(operation) {
  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).catch(reportAxiomFailure);
    }
    return result;
  } catch {
    reportAxiomFailure();
  }
}

// Serialize before buffering: a cyclic payload/getter must not crash an SDK timer.
export const snapshotLog = (event) => JSON.parse(JSON.stringify(event));
