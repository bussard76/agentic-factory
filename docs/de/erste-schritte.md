# Erste Schritte: von null bis zur ersten Wave

Starte einen Agenten in deinem Projekt. Er begleitet dich durch die Einrichtung und das erste Feature; ein Remote-Server ist optional.

## 0. Was du brauchst

- [Orca](https://github.com/stablyai/orca), installiert und gestartet.
- Node 22+ und Git mit deinem Namen und deiner E-Mail (`git config --global user.name` und `user.email`). Dein Projekt braucht ein Git-Repository; `git init` reicht.
- Eine angemeldete Agenten-CLI: Claude Code, Codex oder Pi.
- Optional: `gh` für GitHub-Issues, Figma oder Pencil für den Entwurf.
- **Windows:** Die Skripte der Fabrik brauchen eine Unix-Shell. Installiere WSL 2 (`wsl --install -d Ubuntu` in einer Admin-PowerShell), lass Orcas Terminal auf dieser Distribution laufen, installiere Node 22, Git und die Agenten-CLI in WSL und lege das Projekt im WSL-Dateisystem ab (`~/…`, nicht `/mnt/c/…`). Alles Weitere ist dann gleich. Native Windows-Shells werden nicht unterstützt.

**Der kurze Weg: ein Prompt** statt Abschnitt 1 und 2. Öffne dein Projekt in einem beliebigen Agenten (wenn möglich in Orca) und gib ihm:

```text
Set up the agentic factory for this project. If ~/agentic-factory does not exist, clone https://github.com/bussard76/agentic-factory.git into it; otherwise update it with git -C ~/agentic-factory pull --ff-only. Then read ~/agentic-factory/START.md and follow it: check the prerequisites, move into Orca if needed, and guide me through the onboarding.
```

Der Agent prüft die Voraussetzungen oben und nennt, was fehlt; außerhalb von Orca gestartet, zieht er selbst in ein Orca-Terminal um. Er spricht mit dir auf Deutsch. Auf GitLab trägst du die Clone-URL des Projekts in den Prompt ein.

## 1. Die Fabrik holen

```bash
# auf GitLab? dann die Clone-URL des Projekts aus Code → Clone verwenden
git clone https://github.com/bussard76/agentic-factory ~/agentic-factory
```

## 2. Den Front-Agenten im Projekt starten, in Orca

```bash
cd ~/pfad/zu/deinem-projekt
# stattdessen ein neues Projekt: mkdir my-app && cd my-app && git init -b main && git commit --allow-empty -m "Initial commit"

ORCA="${ORCA_CLI_COMMAND:-orca}"   # unter Linux außerhalb von Orcas eigenen Terminals: ORCA=orca-ide
$ORCA repo add --path "$PWD"
$ORCA agent launch --agent claude --worktree "path:$PWD" --surface terminal --focus \
  --prompt "Read ~/agentic-factory/START.md and set up this project."
```

Der Tab des Agenten öffnet sich in Orca unter deinem Projekt; dort sprichst du mit ihm. Ein Projekt, das Orca schon kennt, erneut hinzuzufügen schadet nicht. Im Orca-Fenster geht dasselbe von Hand: Projekt hinzufügen, darin ein Terminal öffnen, `claude "Read ~/agentic-factory/START.md and set up this project."` starten. Statt `claude` kannst du `codex` oder `pi` verwenden. Der Front-Agent prüft die Voraussetzungen, stellt die [Onboarding-Fragen](../onboarding.md) einzeln, erstellt und pusht den Einführungs-Commit, startet die Fabrik und prüft sie. Er erklärt dir den Projektstand und den nächsten Schritt. Von da an sprichst du mit diesem Agenten; zu Beginn jeder Sitzung prüft er den Status und handelt entsprechend der aktuellen Phase.

Beginne jede spätere Sitzung mit demselben Satz; der Agent liest dann `~/front-agent/<projekt>/FRONT_AGENT.md`.

## 3. Das erste Feature, outside-in

Sag dem Front-Agenten, was du möchtest. Er erarbeitet mit dir zuerst die Oberfläche (Entwurf oder klickbarer Prototyp), dann die ein- und ausgehenden Daten und schließlich die Logik in Worten und als Diagramm. Nach deiner Zustimmung schreibt er ein fertiges Ticket und informiert den Controller. Halte das erste Feature klein: ein sichtbares Verhalten und ein oder zwei Abnahmesätze.

Der Controller organisiert Architekturprüfung, Umsetzung, unabhängigen Test und Integrations-Wave. Die [Branch- und Worktree-Mechanik](workflow.md#branches-und-worktrees-die-mechanik-eines-tickets) erklärt die Einzelheiten.

## 4. Auf der Preview abnehmen

Probiere das integrierte Verhalten mit dem Front-Agenten auf der Preview aus. Ist sie aktiviert, folgt sie `main`; der mitgelieferte Updater kann über die launchd-Vorlage oder Cron laufen. Melde dem Front-Agenten deine Beobachtungen, damit er daraus Tickets macht.

## 5. Später: Remote-Server, weitere Hosts und Rhythmus

- **Remote-Server und Hosts:** Folge der [Server-Einrichtung](../server-setup.md), konfiguriere `hosts.workers` und `hosts.controller.host` und führe `update` und `start` aus. Installiere die Benutzer-Skills auf jedem Host mit Controller oder Front-Agent.
- **Rhythmus:** `rhythm.mode` wählt tags planen/nachts bauen, durchgehend oder eigene Ruhezeiten.
- **Kalibrierung:** Lass Kapazitäts- und Agenten-Kalibrierung auf `auto`, damit Messungen Limits und Modellstufen anpassen.
- **GitHub-Issues:** Wähle `steering.mode: github-issues`, lege die Labels an und führe `setup-matt-pocock-skills` für den gemeinsamen Tracker aus.

## 6. Wenn etwas hakt

| Symptom | Was du prüfst |
|---|---|
| Voraussetzung oder Hook schlägt fehl | Lies die Meldung und den vorgeschlagenen Schritt; Hooks nicht umgehen. |
| Controller tut nichts | Prüfe `~/controller/status.md`, `inbox.md` und `node capacity.mjs --verbose`. |
| Worker steht still | Prüfe `node stallwatch.mjs` und sein Orca-Terminal. |
| Tests wackeln unter Last | Prüfe `~/load.log` (die Zeilen mit `project=<dein Projekt>` am Ende) und das Gate-Journal; senke `capacity.calibration.startSuite`. |
| Update behält deine Änderung | Führe die neue Version aus `.factory/new/` zusammen. |

## Was `start` auf deinem Rechner schreibt

Im Projekt schreiben `init` und `update`, was die Tabelle im Anhang aufführt. `start` (und `install-skills`, `update`, die Bot-Einrichtung) schreiben außerdem die folgenden Dateien **außerhalb** des Projekts. Sonst wird außerhalb nichts geschrieben, abgesehen von den Warteschlangen-Verzeichnissen des Gates (`$TMPDIR/<projekt>-gate-<pool>`) und den Wave-Skripten und -Logs unter `/tmp` (beide nach dem Projekt benannt) und dem, was Orca und dein Agent (zum Beispiel Claude Codes eigene `~/.claude.json`) für sich selbst ablegen. `~` ist das Home des Benutzers, der Orca ausführt: siehe „Ein eigenes HOME isoliert keine zweite Fabrik“ unten. Auf einem entfernten Controller-Host gilt dieselbe Liste auf diesem Host.

| Wo | Was | Zwei Projekte auf einem Host | Entfernen |
|---|---|---|---|
| `~/.claude/skills/<name>`, `~/.agents/skills/<name>` | Die Benutzer-Skills, die Controller und Front-Agent brauchen (`orchestration`, `orca-cli`, `retro`, …; `install-skills --all` fügt alle mitgelieferten Skills hinzu) | Absichtlich geteilt. Ein vorhandener Skill bleibt, wird nie überschrieben (`--force` ersetzt ihn); ein zweites Projekt ändert also nichts am Installierten des ersten. | Lösche die Skill-Ordner, die du nicht mehr willst; andere Projekte und Agenten der Maschine nutzen sie vielleicht. |
| `~/front-agent/<projekt>/` | Das Front-Agent-Bundle, Zustand und Log der Status-Überwachung | Ein Ordner je Projektname | Ordner löschen (nach dem Entfernen des Zeitplans unten). |
| `~/front-agent/.bots/<bot>-<id>/` | Mit einem Orca-Bot als Front-Agent: die Bot-Überwachung (`botwatch.sh`, Zustand, `projects.json`, `wake.md`) | Ein Ordner je Bot, geteilt von allen Projekten, die den Bot nennen (eine Automation weckt den Bot für alle); jedes Projekt ist ein Eintrag in `projects.json`, den `start` zusammenführt (ein zweites Projekt verdrängt das erste nie). `botwatch.mjs`, `hosts.mjs` und `botwatch.sh` stammen vom Projekt, das `start` zuletzt ausgeführt hat, und werden ganz geschrieben (temporäre Datei und Umbenennen), damit Orca nie eine halbe Datei ausführt. | Die Automation `agentic-factory watch · <bot>` in Orca löschen, dann den Ordner. |
| `<hosts.controller.controllerDir>` (Standard `~/controller`) | Das Controller-Bundle: Skripte, `CONTROLLER.md`, Zustand, `heartbeat.log` | Ein Verzeichnis je Projekt. `start` verweigert ein Verzeichnis, das einem anderen Projekt gehört, und sagt, dass `controllerDir` zu setzen ist. | Controller-Sitzung beenden, Verzeichnis löschen. |
| `~/.local/bin/gate`, `~/.local/bin/gate.mjs` | `gate` ist der Verteiler: eine kleine Shell-Datei, die das `gate.mjs` aus dem Controller-Verzeichnis des Projekts startet, in dem sie aufgerufen wird, und mit einer Meldung scheitert, wenn sie nicht sagen kann, welches Projekt das ist. `gate.mjs` ist ein Weiterleiter: die Datei, die die Shim einer älteren Fabrik ausführt; er startet ebenfalls das eigene `gate.mjs` des Projekts und warnt laut, dass das `start` einer älteren Fabrik seine Shim zurückgelegt hat | Geteilt und gefahrlos teilbar. Keine der beiden enthält das Gate eines Projekts: jedes Projekt behält das `gate.mjs` seiner eigenen Fabrik-Version und seine eigene Warteschlange samt Slots (`$TMPDIR/<projekt>-gate-<pool>`). `start` schreibt jede Datei nur, wenn sich der Inhalt unterscheidet, über eine temporäre Datei und ein Umbenennen, und nie über eine höhere `gate-shim`- oder `gate-forward`-Nummer. Das `start` einer älteren Fabrik überschreibt `~/.local/bin/gate` weiterhin mit seiner alten Shim; `doctor` und `status` zeigen, welches Gate installiert ist, und der Weiterleiter warnt bei jedem Gate-Aufruf, der so ankommt. Aktualisiere alle Projekte auf dem Host, damit es aufhört. | Beide Dateien löschen, wenn kein Projekt die Fabrik mehr nutzt. |
| `~/load.log` | Eine Zeile pro Minute von `loadlog.sh`: Last, Speicher, Druck, Zahl der Agenten- und Test-Prozesse, die Gate-Wartenden dieses Projekts und am Ende `project=<name>` | Geteilt. Der Logger jedes Projekts hängt an dieselbe Datei an; jede Zeile trägt ihr Projekt, `start` übergibt den Namen (ein Logger dieses Verzeichnisses, der früher ohne ihn gestartet wurde, wird beendet und ersetzt; seine Zeilen haben kein `project=`). Die Maschinenwerte sind in jeder Zeile einer Minute gleich; `gatewaiters` gehört dem Projekt. Zeilen deines Projekts: `grep ' project=<name>$' ~/load.log`. | Logger beenden (`pkill -f '<controllerDir>/loadlog.sh'`), Datei löschen. |
| Crontab (auf macOS ein launchd-Agent in `~/Library/LaunchAgents/de.agentic-factory.statuswatch.<projekt>.<id>.plist`) | Die Status-Überwachung (alle 5 Minuten, Front-Agent im Terminal) und der Heartbeat des Controllers | Ein Eintrag je Projekt und Verzeichnis, jeweils mit dem Projektnamen markiert; `start` fügt nur den eigenen hinzu und lässt den Rest der Crontab unberührt | `crontab -e` und die mit `# agentic-factory … : <projekt>` markierten Zeilen löschen; auf macOS `launchctl bootout gui/$(id -u)/<label>` und die Plist löschen. |
| `~/.lean-ctx/config.toml` | Nur wenn lean-ctx installiert ist: `allow_paths` bekommt das Projekt, seinen Checkout auf dem Controller-Host und seine Worker-Workspaces, damit der Controller sie lesen darf | Geteilte Datei. Nur fehlende Pfade werden hinzugefügt (jeder als korrekt maskierter TOML-String, also geht jeder Pfad, auch mit `]` oder `"`); was da ist, Kommentare in der Liste eingeschlossen, bleibt Byte für Byte. Sind alle da, wird nichts geschrieben. Das Schreiben ist atomar (temporäre Datei und Umbenennen; die Datei behält ihre Rechte, ein Symlink bleibt einer) und wird neu berechnet, wenn sich die Datei inzwischen geändert hat. Eine Datei, die der Leser nicht ganz versteht (Liste mit anderem als Strings, der Schlüssel doppelt, ein nicht lesbarer String), bleibt unberührt, mit einer Meldung, die die von Hand zu ergänzenden Pfade nennt. | Die Pfade des Projekts aus `allow_paths` löschen. |
| `<controllerDir>/.claude/settings.local.json` | Nur mit pi-Paket `context-mode`: `Read(<pfad>/**)`-Rechte für dieselben Pfade | Im eigenen Controller-Verzeichnis des Projekts | Einträge oder Datei löschen. |
| Orca | Ein Repo-Eintrag (von `init` angelegt), Controller- und Worker-Terminals und -Worktrees (`~/orca/workspaces/<projekt>/`), mit Bot die Automation oben | Nach Projekt benannt | `cleanup.mjs` entfernt fertige Worktrees; den Repo-Eintrag in Orcas Oberfläche entfernen (die CLI kann ihn nur ausblenden). |

**Nie von `start` geschrieben:** die `.env` des Projekts, Controller, Worktrees, Worker oder Bots anderer Projekte und der launchd-Agent der Preview (`preview.plist.template` lädst du selbst).

### Ein eigenes HOME isoliert keine zweite Fabrik

Terminals, die Orca startet (Controller, Worker, das Gate, die Agenten-CLIs), laufen mit dem **echten Home des Benutzers, der Orca ausführt**, egal welches `HOME` du dem `agentic-factory`-Befehl gegeben hast. So verhält sich Orca; die Fabrik kann das nicht ändern. Ein zweites `HOME` verschiebt daher nur, was `start` selbst schreibt (Skills, `~/front-agent`, den Verteiler, das Load-Log); alles, was Controller und Worker später ausführen, liest und schreibt weiter im echten Home, und `~` in einem Pfad wird dort aufgelöst.

Trenne zwei Fabriken auf einer Maschine stattdessen über Namen und **absolute Pfade**: gib jedem Projekt ein eigenes `hosts.controller.controllerDir` (`~/controller-<projekt>` ist in Ordnung, wenn CLI und Orca dasselbe Home nutzen; läuft die CLI unter einem anderen `HOME` als Orca, schreibe es absolut, zum Beispiel `/home/du/controller-<projekt>`, weil Orcas Terminals `~` zum echten Home auflösen) und halte Workspaces und Projekt-Checkouts nach Projektname getrennt. Alles, was die Fabrik auf einer Maschine teilt, steht in der Tabelle oben und ist gefahrlos teilbar: die Skills, der Verteiler, das markierte Load-Log und die `allow_paths`-Liste.

## Anhang: Was der Agent für dich tut (und wie es von Hand geht)

Diese Befehle laufen im Projektverzeichnis; passe den Pfad zur Fabrik bei Bedarf an:

```bash
alias agentic-factory='node ~/agentic-factory/bin/agentic-factory.mjs'
agentic-factory init                         # interaktives Onboarding
agentic-factory init --print-questions       # JSON, schreibt nichts
agentic-factory init --print-questions --answers /pfad/zu/antworten.json
agentic-factory init --answers /pfad/zu/antworten.json
agentic-factory install-skills               # Benutzer-Skills auf diesem Host
agentic-factory start                        # Bündel, Gate, Load-Log, Controller-Sitzung
agentic-factory status --json                # Phase und nächster Schritt
agentic-factory doctor                       # Einrichtung prüfen
agentic-factory update                       # aktualisieren, eigene Änderungen behalten
```

Die Antworten sind ein Objekt mit Frage-IDs als Schlüssel; die Datei gehört außerhalb des Repositories. `init` funktioniert auch allein interaktiv. Ohne Remote erstellt es ein lokales Bare-`origin` unter `~/.factory-remotes/<projekt>-<hash>.git`; mit `git remote set-url origin <url>` kannst du es später ersetzen. Die Einführungsdateien werden als `Adopt agentic-factory (ADR-0001)` committet und gepusht (bei bestehenden ADRs mit der nächsten freien Nummer).

| Dateien von `init` | Zweck |
|---|---|
| `factory.config.json` | Projekteinstellungen ohne Geheimnisse |
| `AGENTS.md`, `CODING_STANDARDS.md` | Agentenregeln und Review-Maßstäbe |
| `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md` | Projekthandbücher |
| `docs/adr/0001-adopt-agentic-factory.md`, `docs/tasks/T00-template.md` | Einführungs-ADR und Ticket-Vorlage |
| `.githooks/` (oder vorhandenes Hook-Verzeichnis), `tools/factory-guardrails.mjs` | Aktivierte Schutzregeln; vorhandene Hooks laufen zuerst als `<hook>.own` |
| `.agents/skills/` und Link `.claude/skills` | Mitgelieferte Skills |
| `.factory/controller/`, `.factory/front-agent/`, `.factory/server/` | Ignorierte Bündel, die `update` neu erzeugt; `.factory/manifest.json` wird committet |

Um die Sitzungen nach `init` von Hand zu starten, installiere die Skills, kopiere die Bündel und starte Gate und Load-Log:

```bash
agentic-factory install-skills
mkdir -p ~/controller && cp -R .factory/controller/. ~/controller/
mkdir -p ~/.local/bin && install -m 755 ~/controller/gate ~/.local/bin/gate   # der Verteiler; das gate.mjs des Projekts bleibt in dessen Controller-Verzeichnis
(cd ~/controller && FACTORY_PROJECT=dein-projektname nohup bash loadlog.sh >/dev/null 2>&1 &)
PROJECT=dein-projektname
mkdir -p ~/front-agent && cp -R .factory/front-agent "$HOME/front-agent/$PROJECT"
```

Starte in einem Terminal in `~/controller` mit `claude "Read ~/controller/CONTROLLER.md and act as the Controller for this project."`. Starte im Projektverzeichnis den Front-Agenten mit `claude "Read ~/front-agent/<projekt>/FRONT_AGENT.md and act as the Front agent."`. Statt `claude` geht deine gewählte CLI. Für einen entfernten Controller siehe [Server-Einrichtung](../server-setup.md).
