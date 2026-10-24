// Minimal test harness: no dependencies, clear output, honest exit code.

export class Suite {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.results = [];
    this.currentGroup = "";
  }

  group(name) {
    this.currentGroup = name;
    this.results.push({ kind: "group", text: name });
    this.onResult && this.onResult({ kind: "group", text: name });
  }

  async test(name, fn) {
    const started = Date.now();
    try {
      await fn();
      this.passed++;
      this.results.push({ kind: "pass", text: name, ms: Date.now() - started });
      this.onResult && this.onResult({ kind: "pass", text: name, ms: Date.now() - started });
    } catch (err) {
      this.failed++;
      const rec = { kind: "fail", text: name, error: (err && err.message) || String(err), stack: err && err.stack, ms: Date.now() - started };
      this.results.push(rec);
      this.onResult && this.onResult(rec);
    }
  }

  /**
   * Record a test that could not run here.
   *
   * A skip is deliberately not counted as a pass: the acceptance criteria
   * forbid reporting an unrunnable scenario as PASS, so the count is carried
   * separately and the reason is printed with it.
   */
  skip(name, reason) {
    this.skipped++;
    const rec = { kind: "skip", text: name, reason: String(reason || "not run") };
    this.results.push(rec);
    this.onResult && this.onResult(rec);
  }

  report() {
    const lines = [];
    for (const r of this.results) {
      if (r.kind === "group") lines.push("\n  " + r.text);
      else if (r.kind === "pass") lines.push("    PASS  " + r.text + (r.ms > 400 ? "  (" + r.ms + "ms)" : ""));
      else if (r.kind === "skip") lines.push("    SKIP  " + r.text + "  - " + r.reason);
      else {
        lines.push("    FAIL  " + r.text);
        lines.push("          " + String(r.error).split("\n").join("\n          "));
      }
    }
    lines.push("");
    lines.push("  " + this.passed + " passed, " + this.failed + " failed" +
      (this.skipped ? ", " + this.skipped + " skipped" : ""));
    lines.push("");
    return lines.join("\n");
  }
}

/** Assertion helpers, kept tiny but strict. */
export const assert = {
  ok(value, message) {
    if (!value) throw new Error(message || "expected a truthy value");
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new Error((message ? message + ": " : "") + "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
    }
  },
  notEqual(actual, expected, message) {
    if (actual === expected) throw new Error((message || "expected values to differ") + " (both " + JSON.stringify(actual) + ")");
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error((message ? message + ": " : "") + "expected " + b + ", got " + a);
  },
  throws(fn, message) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error(message || "expected the call to throw");
  },
  async rejects(fn, message) {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    if (!threw) throw new Error(message || "expected the promise to reject");
  },
  match(value, re, message) {
    if (!re.test(String(value))) throw new Error((message ? message + ": " : "") + JSON.stringify(String(value)) + " does not match " + re);
  },
};
