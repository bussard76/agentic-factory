// A throwaway Controller directory for wave tests: a gate (default: runs its command) and the factory.config.json that names
// the project, which is how integ-wave.sh recognises the project's own gate. Returns the GATE and WAVE_PROJECT a wave needs.
import fs from "node:fs";
import path from "node:path";

export function fakeController(base, { project = "demo", body = '#!/bin/sh\nexec "$@"\n', config = true, name = "gate" } = {}) {
  const dir = path.join(base, `ctl-${project}`);
  fs.mkdirSync(dir, { recursive: true });
  const gate = path.join(dir, name);
  fs.writeFileSync(gate, body, { mode: 0o755 });
  if (config) fs.writeFileSync(path.join(dir, "factory.config.json"), JSON.stringify({ project: { name: project } }));
  return { dir, gate, env: { GATE: gate, WAVE_PROJECT: project } };
}
