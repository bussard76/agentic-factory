// What capacity.mjs measures about processes and how it judges it (docs/capacity.md, "Foreign load"). No configuration
// and no side effects, so the rules can be tested on stand-ins:
//   probeScript()    the POSIX sh text that measures a worker host in one round trip (local sh, or one ssh call)
//   parseProbe()     its output
//   attribute()      which of the busy processes are this project's own, clearly foreign, or unknown
//   repairCaps()     undo the cap step-downs that only the old, wrong foreign-load figure caused

/** A word for sh. A leading ~ is the home directory of the host the script runs on. */
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const hostPath = (p) => (/^~(?=$|\/)/.test(p) ? `"$HOME"${p.length > 1 ? quote(p.slice(1)) : ""}` : quote(p));
export const shQuote = quote;

/** A process below this share of one core (over the sample) is left out. */
export const BUSY_CORES = 0.05;

/**
 * The probe. `ownDirs`: this project's directories on that host (absolute, or starting with ~). CPU per process is the
 * CPU time used between two samples about one second apart: /proc/<pid>/stat where there is a /proc/uptime (Linux),
 * else `ps` accumulated CPU time (macOS, 0.01 s resolution) with the working directories from one `lsof` call. The
 * probe leaves itself out: its shell, everything that shell starts, and what is above it (the ssh session, the caller).
 * FACTORY_PROC and FACTORY_PROBE_TMP exist for the tests' stand-ins (another /proc, other temp roots).
 */
export function probeScript({ project, ownDirs }) {
  return `
P="\${FACTORY_PROC:-/proc}"
for k in cpu memory io; do printf "psi_%s=%s\\n" $k "$(awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); printf "%s", a[2]}}' "$P/pressure/$k" 2>/dev/null)"; done
printf "avail_kb=%s\\n" "$( (awk '/MemAvailable/{print $2; f=1} END{exit !f}' "$P/meminfo" 2>/dev/null) || (vm_stat 2>/dev/null | awk -v ps="$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)" '/Pages (free|inactive|speculative)/{gsub("\\\\.","",$NF); s+=$NF} END{if (s>0) print int(s*ps/1024)}') )"
printf "load1=%s\\n" "$(cut -d' ' -f1 "$P/loadavg" 2>/dev/null || sysctl -n vm.loadavg | awk '{print $2}')"
printf "threads=%s\\n" "$(nproc 2>/dev/null || sysctl -n hw.ncpu)"
for p in unit e2e; do d="\${TMPDIR:-/tmp}/"${quote(`${project}-gate-`)}"$p"; printf "queue_%s=%s\\n" $p "$(ls "$d" 2>/dev/null | grep -c '^ticket-')"; done
home=$(cd "$HOME" 2>/dev/null && pwd -P)
printf "home=%s\\n" "$home"
for d in ${ownDirs.map(hostPath).join(" ")}; do r=$(cd "$d" 2>/dev/null && pwd -P) && printf "own=%s\\n" "$r"; done
for d in \${FACTORY_PROBE_TMP-/tmp /var/tmp /var/folders $TMPDIR}; do r=$(cd "$d" 2>/dev/null && pwd -P) && printf "tmp=%s\\n" "$r"; done
# One line per process: pid ppid cpu-seconds start-seconds(or -) name
if [ -r "$P/uptime" ]; then
  linux=1; hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
  now() { cut -d' ' -f1 "$P/uptime"; }
  # cat, not awk on the files: a process that ends while they are read must not stop the reading.
  sample() { cat "$P"/[0-9]*/stat 2>/dev/null | awk -v hz="$hz" '{ e=0; for (j=length($0); j>0; j--) if (substr($0,j,1)==")") { e=j; break }; if (!e) next; o=index($0,"("); if (split(substr($0,e+2),f," ") < 20) next; printf "%s %s %.2f %.2f %s\\n", $1, f[2], (f[12]+f[13])/hz, f[20]/hz, substr($0,o+1,e-o-1) }'; }
else
  linux=
  now() { perl -MTime::HiRes=time -e 'printf "%.3f\\n", time' 2>/dev/null; }
  sample() { ps -A -o pid=,ppid=,time=,comm= 2>/dev/null | awk '{ d=0; t=$3; if (split(t,x,"-")==2) { d=x[1]; t=x[2] }; n=split(t,c,":"); s=0; for (j=1;j<=n;j++) s=s*60+c[j]; pid=$1; ppid=$2; sub(/^ *[0-9]+ +[0-9]+ +[^ ]+ +/,""); printf "%s %s %.2f - %s\\n", pid, ppid, s+d*86400, $0 }'; }
fi
t0=$(now); s1=$(sample); sleep 1; t1=$(now); s2=$(sample)
if [ -n "$s1" ] && [ -n "$s2" ]; then echo "procs=ok"; fi
# Busy processes (cores used over the sample) and their parents: pid ppid cores name
rows=$( { printf '%s\\n' "$s1"; echo "=="; printf '%s\\n' "$s2"; } | awk -v self="$$" -v t0="$t0" -v t1="$t1" -v min=${BUSY_CORES} '
  BEGIN { dt = t1 - t0; if (dt < 1) dt = 1 }
  $0 == "==" { second = 1; next }
  NF < 4 { next }
  { pid=$1; name=$0; sub(/^[^ ]+ [^ ]+ [^ ]+ [^ ]+ ?/, "", name) }
  !second { cpu1[pid]=$3; start1[pid]=$4; name1[pid]=name; next }
  {
    parent[pid]=$2; names[pid]=name
    if ((pid in cpu1) && start1[pid]==$4 && ($4 != "-" || name1[pid]==name)) d = $3 - cpu1[pid]
    else if ($4 == "-") { d = $3; if (d > dt) d = dt }   # new on macOS: at most one core
    else if ($4 >= t0 - 0.1) d = $3                        # born during the sample
    else d = 0                                           # older, but missed by the first sample: not judged
    used[pid] = (d > 0 ? d / dt : 0)
  }
  END {
    for (p = self; (p in parent) && !(p in probe); p = parent[p]) probe[p] = 1
    for (p in parent) { q = p; for (n = 0; n < 64 && (q in parent); n++) { if (q == self) { probe[p] = 1; break }; q = parent[q] } }
    for (p in used) if (used[p] >= min && !(p in probe)) { q = p; for (n = 0; n < 64 && q > 1 && (q in parent); n++) { show[q] = 1; q = parent[q] } }
    for (p in show) printf "%s %s %.3f %s\\n", p, parent[p], ((p in probe) || used[p] < min ? 0 : used[p]), names[p]
  }')
if [ -n "$rows" ]; then
  printf '%s\\n' "$rows" | sed 's/^/proc=/'
  if [ -n "$linux" ]; then
    cwds=$(printf '%s\\n' "$rows" | while read -r pid rest; do c=$(readlink "$P/$pid/cwd" 2>/dev/null) && printf '%s\\t%s\\n' "$pid" "$c"; done)
  else
    cwds=$(lsof -a -d cwd -p "$(printf '%s\\n' "$rows" | awk '{printf "%s%s", s, $1; s=","}')" -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n\\//{printf "%s\\t%s\\n", p, substr($0,2)}')
  fi
  printf '%s\\n' "$cwds" | sed -n 's/^./cwd=&/p'
  # The git repository a working directory lies in (for a linked worktree, the repository it belongs to). Home itself does not count.
  printf '%s\\n' "$cwds" | cut -f2- | sort -u | while IFS= read -r c; do
    d=$c
    while [ -n "$d" ] && [ "$d" != "$home" ]; do
      if [ -e "$d/.git" ]; then
        g="$d/.git"
        if [ -f "$g" ]; then g=$(sed -n 's/^gitdir: //p' "$g" 2>/dev/null); case $g in /*) ;; *) g="$d/$g" ;; esac; g=\${g%/worktrees/*}; fi
        r=$(cd "$g" 2>/dev/null && pwd -P) || r=$g
        printf 'git=%s\\t%s\\n' "$c" "$r"; break
      fi
      d=\${d%/*}
    done
  done
fi
`;
}

export function parseProbe(text) {
  const kv = {}, own = [], tmp = [], rows = [], cwds = new Map(), repos = new Map();
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i), value = line.slice(i + 1);
    if (key === "own") own.push(value);
    else if (key === "tmp") tmp.push(value);
    else if (key === "proc") { const m = /^(\d+) (\d+) ([\d.]+) ?(.*)$/.exec(value); if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cores: Number(m[3]), name: m[4] }); }
    else if (key === "cwd" || key === "git") { const tab = value.indexOf("\t"); if (tab > 0) (key === "cwd" ? cwds : repos).set(value.slice(0, tab), value.slice(tab + 1)); }
    else kv[key] = value.trim();
  }
  const procs = rows.map((r) => { const cwd = cwds.get(String(r.pid)) ?? ""; return { ...r, cwd, repo: repos.get(cwd) ?? "" }; });
  return { kv, own, tmp, procs };
}

const within = (p, dir) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
/** "own", "foreign" or null (says nothing) for one process, judged by its working directory alone. */
function byDirectory(p, { project, own, tmp }) {
  if (!p.cwd) return null;
  if (own.some((d) => within(p.cwd, d) || (p.repo && within(p.repo, d))) || p.cwd.split("/").includes(project)) return "own";
  if (tmp.some((d) => within(p.cwd, d))) return null;
  return p.repo ? "foreign" : null;
}
/**
 * Cores used over the sample, by owner. A process is judged by its own working directory; one whose directory says
 * nothing takes the verdict of its nearest parent that has one. Only what is positively in another git checkout is
 * foreign; everything else that is not this project's own is unknown.
 */
export function attribute({ procs, own, tmp }, project) {
  const byPid = new Map(procs.map((p) => [p.pid, p])), sum = { own: 0, foreign: 0, unknown: 0 };
  for (const p of procs) {
    if (!(p.cores > 0)) continue;
    let verdict = null;
    for (let q = p, n = 0; q && n < 64 && !verdict; q = byPid.get(q.ppid), n++) verdict = byDirectory(q, { project, own, tmp });
    sum[verdict ?? "unknown"] += p.cores;
  }
  return sum;
}

/**
 * Before this version the calibration lowered the suite cap whenever the foreign-load figure was over its limit, and that
 * figure was wrong. Gives back the steps whose only recorded reason was foreign load, since the last cap set by hand
 * (--set-suite), never above the cap before the first of them and never above `max`. Steps with any other reason stay.
 * Returns null when there is nothing to give back.
 */
export function repairCaps(state, { step, max }) {
  const history = state.history;
  const lastSet = history.map((h) => h.dir).lastIndexOf("set");
  let lost = 0, peak = 0, steps = 0;
  history.forEach((h, i) => {
    if (i <= lastSet || h.dir !== "down" || !Number.isFinite(h.suiteMax) || !String(h.why ?? "").split("; ").every((r) => r.startsWith("foreign load "))) return;
    const before = history.slice(0, i).reverse().find((x) => Number.isFinite(x.suiteMax))?.suiteMax ?? h.suiteMax + step;
    if (before <= h.suiteMax) return;
    lost += before - h.suiteMax; peak = Math.max(peak, before); steps++;
  });
  const suiteMax = Math.min(state.suiteMax + lost, peak, max);
  return steps && suiteMax > state.suiteMax ? { suiteMax, steps } : null;
}
