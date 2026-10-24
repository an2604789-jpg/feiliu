// FTP client: control channel + passive data transfers, with resume.
//
// Implements the subset a download manager needs:
//   USER/PASS, TYPE I, SIZE, REST, PASV/EPSV, RETR, MDTM, LIST, QUIT
// Deliberately no active (PORT) mode: it needs an inbound listener, which is a
// liability on a modern host and unnecessary for downloading.

import net from "node:net";
import { EventEmitter } from "node:events";

const CRLF = "\r\n";

/**
 * A single FTP control connection.
 *
 * Replies are framed, not read line-by-line: a greeting and the reply to the
 * first command routinely arrive in the same TCP segment, so the parser must
 * complete each "NNN...\r\n[text\r\n]NNN ...\r\n" frame before it can be
 * attributed to anything. Completed frames that arrive with no command in
 * flight (the banner) are queued and discarded on the next command.
 */
export class FtpControl extends EventEmitter {
  constructor({ host, port = 21, timeoutMs = 30_000, signal } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.socket = null;
    this.buffer = "";
    this.pending = null;
    this.inbox = [];
    this.openCode = null;
    this.frame = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.on("error", () => {});
      this.socket.setTimeout(this.timeoutMs);
      const onAbort = () => this.close(new Error("aborted"));
      this.signal?.addEventListener("abort", onAbort, { once: true });

      // RFC 959: the server sends a 220 greeting and the client must not issue
      // a command until it has been received. Resolving on TCP connect alone
      // would let the banner arrive while a command is already pending, and the
      // banner would then be consumed as that command's reply.
      this.greeting = new Promise((resolveGreeting, rejectGreeting) => {
        this.onBanner = (reply) => {
          if (reply.code >= 400) rejectGreeting(new Error("FTP server refused the connection: " + reply.code + " " + reply.text));
          else resolveGreeting(reply);
        };
        this.onBannerError = rejectGreeting;
      });
      this.socket.once("connect", () => {
        this.greeting.then(
          () => { this.socket.setTimeout(0); resolve(this); },
          reject
        );
      });
      this.socket.once("error", (err) => reject(err));
      this.socket.once("timeout", () => reject(new Error("FTP control timeout")));
      this.socket.on("data", (chunk) => this.#onData(chunk));
      this.socket.on("close", () => {
        this.signal?.removeEventListener("abort", onAbort);
        if (this.pending) {
          this.pending.reject(new Error("FTP control connection closed"));
          this.pending = null;
        }
        if (this.onBannerError) {
          const fail = this.onBannerError;
          this.onBanner = null;
          this.onBannerError = null;
          fail(new Error("FTP control connection closed before the greeting"));
        }
      });
    });
  }

  /**
   * Frame the byte stream into complete replies.
   *
   * The crucial detail: the greeting is a reply like any other. It is pushed to
   * the inbox, and a command only ever consumes what is left after the banner
   * has been discarded, so a greeting arriving in the same TCP segment as the
   * first command's answer can never be mistaken for that answer.
   */
  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.emit("line", line);

      const m = /^(\d{3})([- ])/.exec(line);
      if (this.frame === null) this.frame = [];
      this.frame.push(line);

      if (this.openCode !== null) {
        if (m && m[1] === this.openCode && m[2] === " ") {
          this.openCode = null;
          this.#pushFrame(Number(m[1]));
        }
        continue;
      }
      if (!m) continue;
      if (m[2] === "-") { this.openCode = m[1]; continue; }
      this.#pushFrame(Number(m[1]));
    }
  }

  #pushFrame(code) {
    const text = this.frame.join(String.fromCharCode(10));
    this.frame = null;
    const reply = { code, text };
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.resolve(reply);
      return;
    }
    if (this.onBanner) {
      const deliver = this.onBanner;
      this.onBanner = null;
      this.onBannerError = null;
      deliver(reply);
      return;
    }
    this.inbox.push(reply);
  }

  /** Send a command and wait for the reply that belongs to it. */
  command(cmd) {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("FTP control connection is not open"));
    }
    return new Promise((resolve, reject) => {
      if (this.pending) return reject(new Error("FTP command already in flight: " + this.pending.cmd));
      // Discard anything that arrived before this command (the banner).
      this.inbox.length = 0;
      this.pending = { cmd, resolve, reject };
      this.socket.write(cmd + CRLF);
    });
  }

  async expect(cmd, codes) {
    const res = await this.command(cmd);
    const ok = Array.isArray(codes) ? codes.includes(res.code) : res.code === codes;
    if (!ok) {
      const err = new Error("FTP " + cmd.split(" ")[0] + " failed: " + res.code + " " + res.text);
      err.ftpCode = res.code;
      throw err;
    }
    return res;
  }

  async login(username, password) {
    await this.expect("USER " + (username || "anonymous"), [230, 331]);
    const res = await this.command("PASS " + (password || "anonymous@"));
    if (res.code !== 230 && res.code !== 202) {
      throw new Error("FTP login rejected: " + res.code + " " + res.text);
    }
    return true;
  }

  async binary() { return this.expect("TYPE I", 200); }

  async size(path) {
    const res = await this.command("SIZE " + path);
    if (res.code !== 213) return null;
    const n = Number(res.text.replace(/^213\s*/, "").trim());
    return Number.isFinite(n) ? n : null;
  }

  async mdtm(path) {
    const res = await this.command("MDTM " + path);
    if (res.code !== 213) return null;
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(res.text.replace(/^213\s*/, "").trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  async passive(signal) {
    const epsv = await this.command("EPSV");
    if (epsv.code === 229) {
      const m = /\|\|\|(\d+)\|/.exec(epsv.text);
      if (m) return this.#dataSocket(this.host, Number(m[1]), signal);
    }
    const pasv = await this.expect("PASV", 227);
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv.text);
    if (!m) throw new Error("cannot parse PASV reply: " + pasv.text);
    const host = m[1] + "." + m[2] + "." + m[3] + "." + m[4];
    const port = (Number(m[5]) << 8) + Number(m[6]);
    return this.#dataSocket(host, port, signal);
  }

  #dataSocket(host, port, signal) {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      s.on("error", () => {});
      s.setTimeout(this.timeoutMs);
      const onAbort = () => { s.destroy(); reject(new Error("aborted")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      s.once("connect", () => { s.setTimeout(0); resolve(s); });
      s.once("error", reject);
      s.once("timeout", () => reject(new Error("FTP data connection timeout")));
    });
  }

  close(reason) {
    try { this.socket?.destroy(); } catch { /* already closed */ }
    if (reason && this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(reason);
    }
  }

  async quit() {
    try { await this.command("QUIT"); } catch { /* servers often just drop */ }
    this.close();
  }
}

/** Parse ftp:// URL into host/port/path/credentials. */
export function parseFtpUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "ftp:") throw new Error("not an ftp URL: " + url);
  return {
    host: u.hostname,
    port: Number(u.port || 21),
    path: decodeURIComponent(u.pathname) || "/",
    username: u.username ? decodeURIComponent(u.username) : "anonymous",
    password: u.password ? decodeURIComponent(u.password) : "anonymous@",
  };
}

/**
 * Stat an FTP resource: size + mtime, or a directory listing when the path is
 * a directory.
 */
export async function ftpStat(url, { timeoutMs = 30_000, signal } = {}) {
  const parsed = parseFtpUrl(url);
  const ctl = new FtpControl({ host: parsed.host, port: parsed.port, timeoutMs, signal });
  await ctl.connect();
  try {
    await ctl.login(parsed.username, parsed.password);
    await ctl.binary();

    const size = await ctl.size(parsed.path);
    if (size !== null) {
      const mtime = await ctl.mdtm(parsed.path);
      return { isDirectory: false, size, mtime };
    }

    const data = await ctl.passive(signal);
    const chunks = [];
    data.on("data", (c) => chunks.push(c));
    const ended = new Promise((res) => data.once("end", res));
    const listReply = await ctl.command("LIST " + parsed.path);
    await ended;
    if (listReply.code !== 150 && listReply.code !== 125 && listReply.code !== 226) {
      throw new Error("FTP LIST failed: " + listReply.code + " " + listReply.text);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const entries = text.split(/\r?\n/).filter(Boolean).map((line) => {
      const m = /^([-dl])([rwxst-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/.exec(line);
      if (!m) return null;
      return { dir: m[1] === "d", size: Number(m[3]), name: m[5] };
    }).filter(Boolean);
    return { isDirectory: true, size: null, mtime: null, entries };
  } finally {
    ctl.close();
  }
}
