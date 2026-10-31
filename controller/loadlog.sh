#!/usr/bin/env bash
# Appends one line per minute to ~/load.log: load, memory, PSI, agent and test process counts, gate waiters.
# Start once per boot (e.g. from the Controller's first cycle): nohup bash ~/controller/loadlog.sh &
PROJECT="${FACTORY_PROJECT:-factory}"
while true; do
  psi() { awk -v k="$1" '/^some/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){split($i,a,"="); printf "%s", a[2]}}' "/proc/pressure/$1" 2>/dev/null; }
  printf '%s load=%s mem=%s/%sMB avail=%sMB psi_cpu=%s psi_mem=%s psi_io=%s agents=%s vitest=%s playwright=%s lockwaiters=%s\n' \
    "$(date +%H:%M)" "$(cut -d' ' -f1-3 /proc/loadavg)" \
    "$(free -m | awk '/Mem/{print $3}')" "$(free -m | awk '/Mem/{print $2}')" "$(free -m | awk '/Mem/{print $7}')" \
    "$(psi cpu)" "$(psi memory)" "$(psi io)" \
    "$(pgrep -c -f 'codex|claude|pi ' 2>/dev/null)" "$(pgrep -c -f vitest 2>/dev/null)" "$(pgrep -c -f playwright 2>/dev/null)" \
    "$( (command -v lsof >/dev/null && lsof -t /tmp/$PROJECT-gate-*-doorman.lock 2>/dev/null | wc -l) || echo 0)" >> "$HOME/load.log"
  sleep 60
done
