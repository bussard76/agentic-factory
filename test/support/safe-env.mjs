// Imported first by every test file, so the suite is safe to run anywhere, also inside an Orca session: every ORCA_* variable is
// removed (they name a real Orca server, terminal and CLI) and a fake `orca` and `orca-ide` that always fail come first on PATH,
// so a child that forgets to set its own fake still cannot reach the real one. Children inherit this through process.env.
// A test that needs an answer from Orca sets ORCA_CLI_COMMAND (or its own PATH) for its child, as before.
// It also pulls in cleanup.mjs, which moves the temp folder of this file (TMPDIR) into one directory that is removed when the file ends.
import fs from "node:fs";
import path from "node:path";
import { tempDir } from "./cleanup.mjs";

for (const k of Object.keys(process.env)) if (k.startsWith("ORCA_")) delete process.env[k];
if (!process.env.AF_TEST_SAFE_BIN) {
  const dir = tempDir("af-no-orca-");
  for (const name of ["orca", "orca-ide"]) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho '{"ok":false,"error":{"code":"no_orca_in_tests"}}'\nexit 1\n`, { mode: 0o755 });
  process.env.AF_TEST_SAFE_BIN = dir;
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
}
