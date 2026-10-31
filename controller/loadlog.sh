#!/usr/bin/env bash
# Appends one line per minute to ~/load.log: load, memory, PSI, agent and test process counts, gate waiters.
# Start once per boot (e.g. from the Controller's first cycle): nohup bash ~/controller/loadlog.sh &
PROJECT="${FACTORY_PROJECT:-$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/controller/factory.config.json","utf8")).project.name)}catch{console.log("factory")}' 2>/dev/null)}"
TMP="${TMPDIR:-/tmp}"
while true; do
  psi() { awk '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); printf "%s", a[2]}}' "/proc/pressure/$1" 2>/dev/null; }
  if [ -r /proc/loadavg ]; then
    load=$(cut -d' ' -f1-3 /proc/loadavg); used=$(free -m | awk '/Mem/{print $3}'); total=$(free -m | awk '/Mem/{print $2}'); avail=$(free -m | awk '/Mem/{print $7}')
  else   # macOS
    load=$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1" "$2" "$3}'); total=$(( $(sysctl -n hw.memsize) / 1048576 ))
    avail=$(vm_stat | awk -v ps="$(sysctl -n hw.pagesize)" '/Pages (free|inactive|speculative)/{gsub("\\.","",$NF); s+=$NF} END{print int(s*ps/1048576)}'); used=$(( total - avail ))
  fi
  waiters=0; for d in "$TMP"/$PROJECT-gate-*/; do [ -d "$d" ] && waiters=$(( waiters + $(ls "$d" 2>/dev/null | grep -c '^ticket-') )); done
  printf '%s load=%s mem=%s/%sMB avail=%sMB psi_cpu=%s psi_mem=%s psi_io=%s agents=%s vitest=%s playwright=%s gatewaiters=%s\n' \
    "$(date +%H:%M)" "$load" "$used" "$total" "$avail" "$(psi cpu)" "$(psi memory)" "$(psi io)" \
    "$(pgrep -f '(^|/)(codex|claude|pi)( |$)' 2>/dev/null | wc -l | tr -d ' ')" "$(pgrep -f '(^|/)vitest( |$)' 2>/dev/null | wc -l | tr -d ' ')" "$(pgrep -f '(^|/)playwright( |$)' 2>/dev/null | wc -l | tr -d ' ')" "$waiters" >> "$HOME/load.log"
  sleep 60
done
