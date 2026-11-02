# Erste Schritte: von null bis zur ersten Wave

Starte einen Agenten in deinem Projekt. Er begleitet dich durch die Einrichtung und das erste Feature; ein Remote-Server ist optional.

## 0. Was du brauchst

- [Orca](https://github.com/stablyai/orca), installiert und gestartet.
- Node 22+ und Git mit deinem Namen und deiner E-Mail (`git config --global user.name` und `user.email`). Dein Projekt braucht ein Git-Repository; `git init` reicht.
- Eine angemeldete Agenten-CLI: Claude Code, Codex oder Pi.
- Optional: `gh` für GitHub-Issues, Figma oder Pencil für den Entwurf.
- **Windows:** Die Skripte der Fabrik brauchen eine Unix-Shell. Installiere WSL 2 (`wsl --install -d Ubuntu` in einer Admin-PowerShell), lass Orcas Terminal auf dieser Distribution laufen, installiere Node 22, Git und die Agenten-CLI in WSL und lege das Projekt im WSL-Dateisystem ab (`~/…`, nicht `/mnt/c/…`). Alles Weitere ist dann gleich. Native Windows-Shells werden nicht unterstützt.

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
| Tests wackeln unter Last | Prüfe `~/load.log` und das Gate-Journal; senke `capacity.calibration.startSuite`. |
| Update behält deine Änderung | Führe die neue Version aus `.factory/new/` zusammen. |

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
mkdir -p ~/.local/bin && install -m 755 ~/controller/gate ~/.local/bin/gate
(cd ~/controller && nohup bash loadlog.sh >/dev/null 2>&1 &)
PROJECT=dein-projektname
mkdir -p ~/front-agent && cp -R .factory/front-agent "$HOME/front-agent/$PROJECT"
```

Starte in einem Terminal in `~/controller` mit `claude "Read ~/controller/CONTROLLER.md and act as the Controller for this project."`. Starte im Projektverzeichnis den Front-Agenten mit `claude "Read ~/front-agent/<projekt>/FRONT_AGENT.md and act as the Front agent."`. Statt `claude` geht deine gewählte CLI. Für einen entfernten Controller siehe [Server-Einrichtung](../server-setup.md).
