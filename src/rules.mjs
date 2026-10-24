// Site rules: exceptions and per-host overrides.
//
// A rule matches a URL by host pattern (glob-ish) and can:
//   * exclude the host from interception entirely;
//   * force a specific connection count or segment size;
//   * add request headers (referer, cookie, user-agent).

/** Glob match supporting * and ? — no regex metacharacter surprises. */
export function globMatch(pattern, value) {
  // Build the regex by walking the pattern, so no layer of escaping can
  // mangle the result.
  let out = "";
  for (const ch of String(pattern)) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else if ("\\^$.|+()[]{}".includes(ch)) out += "\\" + ch;
    else out += ch;
  }

  // "*.example.com" is a subdomain wildcard that also covers the bare domain,
  // which is how exception lists are written in practice.
  if (out.startsWith(".*\\.")) {
    return new RegExp("^(?:.*\\.)?" + out.slice(4) + "$", "i").test(value);
  }
  return new RegExp("^" + out + "$", "i").test(value);
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** The most specific matching rule wins; later rules break ties. */
export function matchRule(url, rules = []) {
  const host = hostOf(url);
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    if (!rule?.pattern) continue;
    if (!globMatch(rule.pattern, host)) continue;
    const score = String(rule.pattern).replace(/\*/g, "").length;
    if (score >= bestScore) { best = rule; bestScore = score; }
  }
  return best;
}

export function isExcepted(url, rules = [], exceptions = []) {
  if (exceptions.some((p) => globMatch(p, hostOf(url)))) return true;
  const rule = matchRule(url, rules);
  if (rule?.action === "exclude") return true;
  return false;
}

/** Merge per-host settings into the effective options for one transfer. */
export function applyRule(url, base, rules = []) {
  const rule = matchRule(url, rules);
  if (!rule || rule.action === "exclude") return { ...base, rule: null };
  const out = { ...base, rule };
  if (rule.connections) out.connections = rule.connections;
  if (rule.segmentBytes) out.segmentBytes = rule.segmentBytes;
  if (rule.headers) out.headers = { ...(base.headers || {}), ...rule.headers };
  if (rule.speedLimit !== undefined) out.maxRate = rule.speedLimit;
  return out;
}
