/**
 * Runs the suite with `better-sqlite3` built for Node, then puts it back on the
 * Electron ABI — unconditionally.
 *
 * The native module can only be built for one runtime at a time, and the suite
 * runs under plain Node while the app runs under Electron, so every test run has
 * to flip it and flip it back. This used to be a `test` + `posttest` pair, but
 * `posttest` only fires when `test` exits 0: a single failing test left the
 * module on the Node ABI, and the next `pnpm dev` could not load it. That is not
 * merely inconvenient — `getDb()` reads an unopenable database as a reason to
 * quarantine, so a red test run could cost a developer their local corpus (it
 * did, once). Hence a wrapper whose restore step runs in a `finally`.
 *
 * Args are passed through to vitest: `node scripts/test.mjs run some.test.ts`.
 */
import { spawnSync } from "node:child_process";

const BUILD_FOR_NODE = "pnpm rebuild better-sqlite3";
const RESTORE_FOR_ELECTRON = [
  "npx rimraf node_modules/better-sqlite3/build node_modules/.vite",
  "npx electron-rebuild -w better-sqlite3",
];

/** Runs a command inheriting stdio; returns its exit code. */
function run(command) {
  const { status, error } = spawnSync(command, {
    stdio: "inherit",
    // pnpm/npx are .cmd shims on Windows, which need a shell to resolve.
    shell: true,
  });
  if (error) throw error;
  return status ?? 1;
}

// Ctrl-C in watch mode reaches the child through the terminal's process group
// either way. Ignoring it here keeps *this* process alive long enough to run the
// restore below — otherwise quitting a watch session is exactly the case that
// leaves the module on the wrong ABI.
process.on("SIGINT", () => {});

let code = 1;
try {
  code = run(BUILD_FOR_NODE);
  if (code === 0) code = run(`npx vitest ${process.argv.slice(2).join(" ")}`);
} finally {
  let restoreFailed = false;
  for (const step of RESTORE_FOR_ELECTRON) {
    if (run(step) !== 0) restoreFailed = true;
  }
  if (restoreFailed) {
    console.error(
      "\nCould not rebuild better-sqlite3 for Electron. `pnpm dev` will fail to\n" +
        "load it until this succeeds: npx electron-rebuild -w better-sqlite3",
    );
  }
}

process.exit(code);
