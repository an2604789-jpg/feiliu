// Local certificate authority for HTTPS inspection.
//
// Decrypting TLS requires the client to trust a certificate we can mint. That
// is a deliberate trust decision with real consequences, so this module:
//
//   * only creates the authority when explicitly asked;
//   * keeps the private key in the user's data directory, never in the repo;
//   * signs one short-lived leaf per host and caches it;
//   * exposes the CA certificate path so the user can install and remove it
//     deliberately.
//
// Key generation shells out to openssl, which ships with Git for Windows and
// every mainstream Linux/macOS. Node cannot mint X.509 certificates on its own.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { existsSync } from "node:fs";

import { paths, ensureDirs } from "./paths.mjs";

// Windows separators are built with String.fromCharCode so no escaping layer
// can double them; a literal C:\\\\Program would work on Windows (which
// collapses repeated separators) but break anywhere else.
const SEP = String.fromCharCode(92);
const WIN_OPENSSL = [
  ["C:", "Program Files", "Git", "usr", "bin", "openssl.exe"],
  ["C:", "Program Files", "Git", "mingw64", "bin", "openssl.exe"],
  ["C:", "Program Files (x86)", "Git", "usr", "bin", "openssl.exe"],
].map((parts) => parts.join(SEP));

const OPENSSL_CANDIDATES = [
  process.env.OPENSSL_PATH,
  "openssl",
  ...WIN_OPENSSL,
  "/usr/bin/openssl",
  "/usr/local/bin/openssl",
  "/opt/homebrew/bin/openssl",
].filter(Boolean);

let cachedOpenssl = null;

function run(bin, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(bin + " exited " + code + ": " + err.trim().split(String.fromCharCode(10)).slice(-2).join(" ")));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Locate a usable openssl binary, or null. */
export async function findOpenssl(explicit) {
  if (explicit) {
    try { await fsp.access(explicit); cachedOpenssl = explicit; return explicit; } catch { /* keep looking */ }
  }
  if (cachedOpenssl) return cachedOpenssl;
  for (const candidate of OPENSSL_CANDIDATES) {
    if (candidate !== "openssl" && !existsSync(candidate)) continue;
    try {
      await run(candidate, ["version"]);
      cachedOpenssl = candidate;
      return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

export class CertificateAuthority {
  constructor({ dir = path.join(paths.root, "ca"), openssl } = {}) {
    this.dir = dir;
    this.explicitOpenssl = openssl;
    this.keyPath = path.join(dir, "downloadx-ca.key");
    this.certPath = path.join(dir, "downloadx-ca.crt");
    this.leafDir = path.join(dir, "leaves");
    this.leafCache = new Map();
  }

  get installed() {
    return fs.existsSync(this.keyPath) && fs.existsSync(this.certPath);
  }

  /** Create the authority if it does not exist yet. */
  async ensure() {
    await ensureDirs();
    await fsp.mkdir(this.leafDir, { recursive: true });
    if (this.installed) return this.describe();

    const openssl = await findOpenssl(this.explicitOpenssl);
    if (!openssl) {
      const err = new Error("openssl was not found; HTTPS inspection needs it to mint certificates");
      err.code = "NO_OPENSSL";
      throw err;
    }

    // A long-lived CA: it only signs leaf certificates, and rotating it would
    // force the user to re-install trust on every machine.
    await run(openssl, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", this.keyPath,
      "-out", this.certPath,
      "-days", "3650",
      "-subj", "/CN=downloadx local CA/O=downloadx",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-addext", "subjectKeyIdentifier=hash",
    ]);

    // The private key must not be world-readable.
    try { await fsp.chmod(this.keyPath, 0o600); } catch { /* Windows ACLs cover it */ }
    return this.describe();
  }

  describe() {
    return {
      installed: this.installed,
      certPath: this.certPath,
      keyPath: this.keyPath,
      /** What the user must do to enable HTTPS inspection. */
      installHint: "Import downloadx-ca.crt into the Trusted Root Certification Authorities store, then point the client at this proxy.",
    };
  }

  /** Read the CA material for TLS use. */
  async load() {
    if (!this.installed) throw new Error("CA has not been created yet");
    return {
      key: await fsp.readFile(this.keyPath, "utf8"),
      cert: await fsp.readFile(this.certPath, "utf8"),
    };
  }

  /**
   * Leaf certificate for one host, cached on disk and in memory.
   * @returns {Promise<{key:string, cert:string}>}
   */
  async leafFor(host) {
    const safe = host.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (this.leafCache.has(safe)) return this.leafCache.get(safe);

    const keyPath = path.join(this.leafDir, safe + ".key");
    const certPath = path.join(this.leafDir, safe + ".crt");
    const csrPath = path.join(this.leafDir, safe + ".csr");
    const extPath = path.join(this.leafDir, safe + ".ext");

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const material = { key: await fsp.readFile(keyPath, "utf8"), cert: await fsp.readFile(certPath, "utf8") };
      this.leafCache.set(safe, material);
      return material;
    }

    const openssl = await findOpenssl(this.explicitOpenssl);
    if (!openssl) throw new Error("openssl not found");

    // One leaf covers both the bare host and its wildcard, which is what
    // browsers expect for a host like www.example.com.
    const altNames = ["DNS:" + host];
    const labels = host.split(".");
    if (labels.length > 2) altNames.push("DNS:*." + labels.slice(1).join("."));
    await fsp.writeFile(extPath, [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=" + altNames.join(","),
    ].join(String.fromCharCode(10)));

    await run(openssl, [
      "req", "-new", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", csrPath,
      "-subj", "/CN=" + host,
    ]);
    await run(openssl, [
      "x509", "-req", "-in", csrPath,
      "-CA", this.certPath, "-CAkey", this.keyPath,
      "-CAcreateserial", "-out", certPath,
      "-days", "397",           // browsers reject leaves valid for longer
      "-extfile", extPath,
    ]);
    await fsp.rm(csrPath, { force: true });
    await fsp.rm(extPath, { force: true });

    const material = { key: await fsp.readFile(keyPath, "utf8"), cert: await fsp.readFile(certPath, "utf8") };
    this.leafCache.set(safe, material);
    return material;
  }

  /**
   * Async leaf for the capture proxy (P-15): same resolution as leafFor —
   * in-memory/disk hit is instant, a miss is signed and persisted. The
   * proxy's #mitmConnect awaits this before building the TLS socket, so an
   * unseen host is minted on its first CONNECT instead of 502ing. (Before
   * this existed, nothing in the repository ever called leafFor, and the
   * proxy's read-only sync lookup answered 502 for every un-pre-generated
   * host.)
   */
  async getLeaf(host) {
    return this.leafFor(host);
  }

  /**
   * Synchronous leaf lookup, for callers that already hold a signed leaf.
   * Read-only by design (openssl signing is async and cannot happen here);
   * the capture proxy uses the async leafFor/getLeaf path to sign on demand,
   * so this remains the fast path for pre-generated material only.
   */
  leafForSync(host) {
    const safe = host.replace(/[^a-zA-Z0-9._-]/g, "_");
    if (this.leafCache.has(safe)) return this.leafCache.get(safe);
    const keyPath = path.join(this.leafDir, safe + ".key");
    const certPath = path.join(this.leafDir, safe + ".crt");
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
      throw new Error("no leaf certificate for " + host + "; call leafFor() first");
    }
    const material = { key: fs.readFileSync(keyPath, "utf8"), cert: fs.readFileSync(certPath, "utf8") };
    this.leafCache.set(safe, material);
    return material;
  }

  /** Remove every generated certificate and key. */
  async destroy() {
    this.leafCache.clear();
    await fsp.rm(this.dir, { recursive: true, force: true });
    return true;
  }
}
