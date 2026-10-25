// System-proxy discovery (P-18, batch-7).
//
// proxyMode used to be a config field with a GUI dropdown and zero consumers:
// picking "use system proxy" read neither the system's proxy nor anything
// else. This module is the missing half — it discovers what the operating
// system itself is configured to use, with no runtime dependency:
//
//   * win32: `reg query` over HKCU\...\Internet Settings (ProxyEnable,
//     ProxyServer, ProxyOverride) — the values the Windows proxy settings UI
//     writes and every WinINET application reads;
//   * posix: the standard http_proxy / https_proxy / all_proxy / no_proxy
//     environment variables.
//
// Everything that touches the OS is kept behind small pure parsers
// (parseRegQueryOutput / parseProxyServer / parseProxyOverride /
// parseEnvProxy) so the shapes can be unit-tested from plain sample strings
// without spawning anything. resolveSystemProxy() itself never throws: a
// missing key, a failed `reg`, a timeout — all collapse to null, and the
// caller decides what "no system proxy found" means for it (downloader.mjs
// falls back to the Settings proxy there).
//
// The result is cached for 30s INCLUDING failures, so a burst of tasks does
// not spawn a reg.exe per download, and a broken machine does not get
// hammered either. Nothing here writes to disk and nothing logs: a proxy
// address is configuration, and a proxy URL that carries user:pass (the
// manual Settings value may) must never reach a log line via this module.

import { execFile } from "node:child_process";

/** The WinINET per-user proxy key (same one the Settings UI writes). */
const REG_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** How long a discovery result — success OR failure — is reused. */
const CACHE_MS = 30_000;

/** `reg query` is given a hard ceiling so a wedged console host cannot hang a download start. */
const REG_TIMEOUT_MS = 5_000;

/** Module-level cache: { at, value } — value may be null (a cached failure). */
let cache = { at: 0, value: null, filled: false };

/**
 * Parse the stdout of `reg query <key>` into the three values we care about.
 *
 * Sample shape (columns are space-aligned, values may contain spaces):
 *
 *   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *       ProxyEnable    REG_DWORD    0x1
 *       ProxyServer    REG_SZ    127.0.0.1:8080
 *       ProxyOverride    REG_SZ    localhost;127.0.0.1;<local>
 *
 * The key-path header and any banner line simply do not match the
 * name-TYPE-value shape and are skipped. DWORDs arrive as 0x-hex.
 *
 * @returns {{enable:boolean, server:string, override:string}}
 */
export function parseRegQueryOutput(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:SZ|DWORD|EXPAND_SZ|BINARY|MULTI_SZ)\s*(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].trim();
  }
  const raw = values.ProxyEnable ?? "";
  const enable = /^0x/i.test(raw) ? parseInt(raw, 16) === 1 : Number(raw) === 1;
  return { enable, server: values.ProxyServer ?? "", override: values.ProxyOverride ?? "" };
}

/**
 * Normalise one proxy address to a URL string the net layer accepts.
 *
 * The registry never carries a scheme (just host:port), and the net layer's
 * `new URL(proxy)` needs one, so a bare address gains "http://" — an HTTP
 * proxy is what the WinINET setting means regardless of the traffic carried
 * through it. An address that already has a scheme (socks5://…, http://…)
 * passes through unchanged. Anything unparseable yields null.
 *
 * @returns {string|null}
 */
function withScheme(addr) {
  const s = String(addr || "").trim();
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "http://" + s;
  try {
    const u = new URL(candidate);
    return u.hostname ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Parse the ProxyServer registry value into per-scheme proxy URLs.
 *
 * Two documented Windows forms:
 *   * "host:port" (or bare "host") — the same proxy for every protocol;
 *   * "http=h:p;https=h:p;ftp=h:p;socks=h:p" — per-protocol entries; the
 *     keys we can use are http/https (an https= entry is still an HTTP
 *     proxy reached over cleartext, so it gains http:// too). If only socks=
 *     is listed, Windows routes everything through it, so both fields become
 *     socks5:// and net.mjs's SOCKS path takes over.
 *
 * @returns {{http:string|null, https:string|null}|null} null when nothing usable is listed
 */
export function parseProxyServer(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  if (!s.includes("=")) {
    const url = withScheme(s);
    return url ? { http: url, https: url } : null;
  }
  const entries = {};
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const proto = pair.slice(0, eq).trim().toLowerCase();
    const addr = pair.slice(eq + 1).trim();
    if (proto && addr) entries[proto] = addr;
  }
  const http = entries.http ? withScheme(entries.http) : null;
  const https = entries.https ? withScheme(entries.https) : null;
  if (http || https) return { http, https };
  if (entries.socks) {
    // A socks= entry must never gain http:// from withScheme — build the
    // socks5 URL from the raw address, keeping any scheme it already has.
    const raw = entries.socks.trim();
    const socks = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "socks5://" + raw;
    try {
      const u = new URL(socks);
      if (u.hostname) return { http: socks, https: socks };
    } catch { /* an unparseable socks address is no proxy at all */ }
  }
  return null;
}

/**
 * ProxyOverride (win32) → a noProxy list. Semicolon-separated, empties
 * dropped; Windows' "<local>" token is kept verbatim — matchesNoProxy knows it.
 *
 * @returns {string[]}
 */
export function parseProxyOverride(value) {
  return String(value || "")
    .split(";")
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * POSIX branch: the standard proxy environment variables.
 *
 * http falls back to all_proxy, https likewise (curl's precedence within a
 * field), no_proxy is a comma-separated exclusion list. Uppercase wins over
 * lowercase when both are set, matching the envProxyFor convention already
 * used by the capture proxy (src/proxy.mjs).
 *
 * @param {object} env an environment-like object (process.env in production)
 * @returns {{http:string|null, https:string|null, noProxy:string[]}|null} null when no proxy variable is set
 */
export function parseEnvProxy(env = process.env) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = env[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const rawHttp = pick("HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy");
  const rawHttps = pick("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy");
  const http = rawHttp ? withScheme(rawHttp) : null;
  const https = rawHttps ? withScheme(rawHttps) : null;
  if (!http && !https) return null;
  const noProxy = pick("NO_PROXY", "no_proxy");
  return {
    http,
    https,
    noProxy: noProxy ? noProxy.split(",").map((t) => t.trim()).filter(Boolean) : [],
  };
}

/**
 * Is this host the machine itself (loopback)? P-21's "<local>" extension.
 * Deliberately literal: dotted loopback (127.x), the IPv6 loopback and the
 * "localhost" name — nothing smarter, because a noProxy list is not the place
 * to start classifying whole address families.
 */
function isLoopbackHost(host) {
  return host === "localhost" || host.startsWith("127.") || host === "::1";
}

/**
 * Does a host match a noProxy / ProxyOverride list?
 *
 * Deliberately the simple, common semantics (curl-style), because the OS lists
 * are written for browsers and shells, not for a full WPAD engine:
 *   * "*"            — bypass everything;
 *   * "<local>"      — bare hostnames (no dots) AND loopback targets stay
 *                      direct: the Windows token, extended (P-21) so a list
 *                      that only says "<local>" still keeps 127.x/::1 off the
 *                      proxy — the real-machine smoke showed loopback landing
 *                      on the system proxy otherwise;
 *   * "127.*"        — a literal address prefix, the form Windows' own UI
 *                      writes for "this whole range" (P-21): the host must
 *                      start with "127." — the dot anchors the prefix, so
 *                      "1270.…" does not match;
 *   * ".example.com" / "*.example.com" — the domain and anything under it;
 *   * "example.com"  — the host itself, or any subdomain of it;
 *   * anything else  — exact host match (so "127.0.0.1" and "localhost" work).
 *
 * @param {string} hostname the host a transfer is about to contact
 * @param {string[]} [noProxy] the exclusion list
 * @returns {boolean}
 */
export function matchesNoProxy(hostname, noProxy) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !Array.isArray(noProxy) || noProxy.length === 0) return false;
  for (const raw of noProxy) {
    let pat = String(raw || "").trim().toLowerCase();
    if (!pat) continue;
    if (pat === "*") return true;
    if (pat === "<local>") {
      if (!host.includes(".") || isLoopbackHost(host)) return true;
      continue;
    }
    if (pat.startsWith("*.")) pat = pat.slice(1);   // "*.x" and ".x" mean the same thing here
    if (pat.endsWith(".*")) {
      if (host.startsWith(pat.slice(0, -1))) return true;   // "127.*" → startsWith "127."
      continue;
    }
    if (pat.startsWith(".")) {
      if (host === pat.slice(1) || host.endsWith(pat)) return true;
      continue;
    }
    if (host === pat || host.endsWith("." + pat)) return true;
  }
  return false;
}

/**
 * The real `reg query` runner. windowsHide because a console window flashing
 * on every discovery would be unacceptable on a desktop the user is working
 * on; the timeout is a hard kill so a stuck reg.exe cannot stall a download.
 * @returns {Promise<string>} stdout
 */
function regQueryRunner(key) {
  return new Promise((resolve, reject) => {
    execFile(
      "reg",
      ["query", key],
      { windowsHide: true, timeout: REG_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || ""));
      }
    );
  });
}

/**
 * Discover the system proxy. NEVER throws — every failure is null.
 *
 * @param {{platform?:string, env?:object, runner?:(key:string)=>Promise<string>,
 *          now?:()=>number, force?:boolean}} [opts] injection points for tests;
 *        production needs none of them.
 * @returns {Promise<{http:string|null, https:string|null, noProxy:string[]}|null>}
 *          null = no usable system proxy (disabled, unset, or discovery failed)
 */
export async function resolveSystemProxy(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? Date.now;
  if (!opts.force && cache.filled && now() - cache.at < CACHE_MS) {
    return cache.value;
  }
  let value = null;
  if (platform === "win32") {
    try {
      const runner = opts.runner ?? regQueryRunner;
      const { enable, server, override } = parseRegQueryOutput(await runner(REG_KEY));
      if (enable) {
        const parsed = parseProxyServer(server);
        if (parsed) value = { http: parsed.http, https: parsed.https, noProxy: parseProxyOverride(override) };
      }
    } catch {
      value = null;   // reg missing, key missing, timeout — all mean "not discovered"
    }
  } else {
    value = parseEnvProxy(opts.env ?? process.env);
  }
  cache = { at: now(), value, filled: true };
  return value;
}

/** Forget the cached discovery (tests re-seed it deterministically). */
export function clearSystemProxyCache() {
  cache = { at: 0, value: null, filled: false };
}
