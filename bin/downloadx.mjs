#!/usr/bin/env node
// Entry point. main() resolves with an exit code; the process is allowed to
// finish its pending I/O naturally (setting exitCode rather than calling
// process.exit) so sockets and fetch handles can close without tripping a
// libuv assertion on Windows.
import { main } from "../src/cli.mjs";

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    process.stderr.write("\nfatal: " + ((err && err.stack) || err) + "\n");
    process.exitCode = 1;
  });
