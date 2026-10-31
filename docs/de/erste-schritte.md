# Erste Schritte: von null bis zur ersten Wave

Diese Anleitung führt ein neues Projekt von nichts bis zur ersten geprüften Änderung auf `main`, alles auf dem eigenen Rechner. Ein Remote-Server kommt später und ist optional. Rechne mit etwa einer Stunde, das meiste davon ist Lesen.

## 0. Was du brauchst

- **Orca**, installiert und gestartet ([orca.earendil.works](https://orca.earendil.works)). Es ist der Runner: Worktrees und Terminals pro Worker, strukturierte Nachrichten zwischen Controller und Workern, Remote-Server. `init` bricht ohne Orca ab.
- **Node 22+**, **git** und ein Repository für dein Projekt (ein frisches `git init` reicht).
- **Eine Agenten-CLI**, eingeloggt: Codex (`codex`), Claude Code (`claude`) oder Pi (`pi`). Worker, Controller und Front-Agent sind alle Sitzungen davon.
- Optional: **gh** (Steuerung über GitHub-Issues), **Figma** oder **Pencil** (für Stufe 1 von Outside-in).

## 1. Die Fabrik holen

```bash
git clone https://github.com/bussard76/agentic-factory ~/agentic-factory
alias agentic-factory='node ~/agentic-factory/bin/agentic-factory.mjs'
```

(Sobald das Paket auf npm liegt, ersetzt `npx agentic-factory` den Alias.) Git braucht Name und E-Mail (`git config --global user.name …`), weil die Agenten unter deiner Identität committen.

## 2. Das Onboarding im Projekt starten

```bash
cd ~/pfad/zu/deinem-projekt
agentic-factory init
```

`init` stellt eine Frage nach der anderen, die empfohlene Antwort zuerst. Für den ersten Versuch nimm die Vorgaben, mit einer Ausnahme: Antworte bei den Hosts mit **„Nur auf diesem Rechner“**. Die Fragen und ihr Grund stehen in [onboarding.md](../onboarding.md).

Hat das Repo noch kein Remote, legt `init` ein **lokales Bare-Remote** an (`~/.factory-remotes/<projekt>.git`) und setzt es als `origin`, weil alle Skripte über `origin` holen und pushen. Ersetze es jederzeit durch ein echtes Remote: `git remote set-url origin <url>`.

Es entstehen:

| | |
|---|---|
| `factory.config.json` | alles Projektspezifische; keine Geheimnisse |
| `AGENTS.md`, `CODING_STANDARDS.md` | die Regeln der Agenten und die Maßstäbe des Reviewers |
| `docs/coordinator.md`, `docs/dev-workflow.md`, `docs/review-protocol.md`, `docs/architect-protocol.md`, `docs/debt.md` | die Handbücher, ausgefüllt für dein Projekt |
| `docs/adr/0001-adopt-agentic-factory.md`, `docs/tasks/T00-template.md` | der Einführungs-ADR und die Ticket-Vorlage |
| `.githooks/`, `tools/factory-guardrails.mjs` | die Git-Schutzregeln, schon aktiv (`core.hooksPath`) |
| `.agents/skills/` (+ Link `.claude/skills`) | die mitgelieferten Skills |
| `.factory/controller/`, `.factory/front-agent/`, `.factory/server/` | die Bündel für Controller, Front-Agent und einen späteren Server |

Lies `docs/dev-workflow.md` einmal. Das ist der ganze Prozess in klarer Sprache.

## 3. Der Einführungs-Commit

`init` hat die geschriebenen Dateien bereits als `Adopt agentic-factory (ADR-0001)` committet und nach `origin` gepusht, damit die ersten Worker und die erste Wave von einem `main` starten, das `AGENTS.md`, die Handbücher und die Hooks enthält. Ab jetzt sind `AGENTS.md`, die Hooks und der ADR-Ordner geschützte Dateien: Ein Commit, der sie berührt, braucht einen `ADR-NNNN`-Verweis in der Nachricht. Probiere einen ohne, um den Hook sprechen zu hören. (`doctor` kommt nach Schritt 4: Er prüft auch die Skills auf Benutzerebene, die du dort installierst.)

## 4. Die Skills auf Benutzerebene installieren, dann den Controller starten

Controller und Front-Agent laufen außerhalb des Repos und sehen die `.agents/skills` des Projekts nicht. Installiere die Skills, auf die sie angewiesen sind, auf Benutzerebene, und zwar auf **jedem** Host, auf dem einer von beiden läuft. Entscheidend sind die Orca-Skills: Ohne `orchestration` und `orca-cli` kann ein Agent keine Worker starten, beobachten oder freigeben.

```bash
agentic-factory install-skills            # ~/.claude/skills und ~/.agents/skills auf diesem Rechner
```

Jetzt `agentic-factory doctor` ausführen: Alles sollte `OK` sein außer dem Controller, der noch nicht läuft. Dann der Controller:

```bash
cp -R .factory/controller ~/controller
mkdir -p ~/.local/bin && install -m 755 ~/controller/gate ~/.local/bin/gate   # das Gate braucht nur node, kein flock
(cd ~/controller && nohup bash loadlog.sh >/dev/null 2>&1 &)
```

Öffne ein Terminal in `~/controller` und starte dort eine Agenten-Sitzung, zum Beispiel:

```bash
claude "Lies ~/controller/CONTROLLER.md und handle als Controller für dieses Projekt."
# oder: codex "Lies ~/controller/CONTROLLER.md und handle als Controller für dieses Projekt."
```

Der Controller liest sein Handbuch, zieht das Projekt, findet keine Tickets, schreibt `~/controller/status.md` und wartet. Schau in die Statusdatei: Das ist, was der Front-Agent dir zeigen wird.

## 5. Den Front-Agent starten

```bash
mkdir -p ~/front-agent && cp -R .factory/front-agent ~/front-agent/<projekt>
```

Im Projektverzeichnis eine zweite Agenten-Sitzung starten:

```bash
claude "Lies ~/front-agent/<projekt>/FRONT_AGENT.md und handle als Front-Agent. Ich bin <dein Name>."
```

Ab jetzt sprichst du nur noch mit dieser Sitzung. Frag sie nach dem Stand; sie liest `~/controller/status.md` und zeigt dir die Tabelle.

## 6. Die erste Funktion, von außen nach innen

Sag dem Front-Agent, was du willst. Er wird:

1. die **Oberfläche** mit dir skizzieren (ein Figma-Frame oder ein Klick-Fake über den `prototype`-Skill) und nach `design/<feature>/` exportieren
2. die **Daten rein und raus** am Fake auflisten
3. die **Logik** mit dir in Worten und als Mermaid-Diagramm abstimmen (`grilling`)
4. das **Ticket** schreiben: `docs/tasks/T01-<slug>.md` aus der Vorlage (oder ein GitHub-Issue mit `ready-for-agent`), mit `Status: ready`
5. eine Zeile in `~/controller/inbox.md` legen

Halte die erste Funktion winzig: ein sichtbares Verhalten, ein oder zwei Abnahmesätze. Es geht darum, die Maschine einmal laufen zu sehen.

## 7. Zusehen, wie die Maschine läuft

Der Controller nimmt das Ticket im nächsten Zyklus auf (alle 10 Minuten oder sofort, wenn er angestoßen wird). In `status.md` und in deinen Worktrees unter `~/orca/workspaces/<projekt>/` (oder wohin `workspacesDir` zeigt) siehst du:

1. **Architekt**, Spec-Review → `docs/reviews/T01-architecture-spec.md`, `Verdict: pass`
2. **Developer** baut testgetrieben auf `agents/t01`, pusht, berichtet
3. **Tester** prüft auf aktuellem `main` plus Branch, lässt die vollen Gates über `gate` laufen, schreibt `docs/reviews/T01-review-1.md`
4. bei `fail`: Nacharbeit im selben Worktree; bei `pass`: die **Wave** führt den Task-Branch und seinen bestandenen Review-Branch auf dem Integrations-Branch zusammen, lässt die Gates einmal laufen, pusht nach `main`
5. **Aufräumen**: fertige Worktrees verschwinden, der Status zeigt die Zahlen

Versuche einmal, von Hand ohne Review nach `main` zu pushen. Der Pre-Push-Hook lehnt ab und sagt warum.

Die genaue Branch- und Worktree-Mechanik eines Tickets, Schritt für Schritt, steht in [workflow.md](workflow.md#branches-und-worktrees-die-mechanik-eines-tickets).

## 8. Auf dem Preview abnehmen

Wenn du den Preview aktiviert hast, hält `front-agent/preview-update.sh` einen separaten Klon auf dem aktuellen `main` und startet deine App auf dem konfigurierten Port neu, sobald `main` sich bewegt. Lade ihn als launchd-Agent (macOS) aus `preview.plist.template` oder per cron. Teste das neue Verhalten dort; Befunde gehen an den Front-Agent und werden Tickets.

## 9. Später: Remote-Server, mehr Hosts, die Nachtschicht

- **Remote-Server:** [server-setup.md](../server-setup.md) mit `.factory/server/` durchgehen, den Host in `factory.config.json` → `hosts.workers` eintragen, `hosts.controller.host` darauf setzen, wenn der Controller dorthin ziehen soll, `agentic-factory update` ausführen, das neue `.factory/controller/`-Bündel auf den Server kopieren und dort die Skills auf Benutzerebene aus dem Bündel installieren (`cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/`). Mehrere Hosts gehen genauso; `start.mjs --on <host>` wählt einen.
- **Rhythmus:** `rhythm.mode` schaltet zwischen tags planen/nachts bauen, durchgehend und eigenen Ruhezeiten.
- **Kalibrierung:** `capacity.calibration.mode` und `agents.calibration` auf `auto` lassen. Obergrenzen und Modellstufen starten niedrig und folgen den Messungen; der nächtliche Audit sagt dir, was sich geändert hat und warum.
- **GitHub-Issues** statt Task-Dateien: `steering.mode: github-issues`, die Labels anlegen, einmal `setup-matt-pocock-skills` ausführen, damit `wayfinder`, `to-tickets` und `to-spec` denselben Tracker nutzen.

## 10. Wenn etwas hakt

| Symptom | Schau in |
|---|---|
| `init` verweigert oder ein Hook blockiert einen Commit | Die Meldung nennt Regel und Datei; `--no-verify` ist nie die Antwort |
| Der Controller tut nichts | `~/controller/status.md` (frisch?), `inbox.md` (ist das Ticket `ready`?), `node capacity.mjs --verbose` (wartet er auf Kapazität?) |
| Ein Worker steht still | Ausgabe von `node stallwatch.mjs`; in Orca eine Zeile in sein Terminal schicken |
| Tests wackeln unter Last | `~/load.log`, das Journal (`type: gate`), `capacity.calibration.startSuite` senken |
| Du hast eine Vorlage geändert und `update` behält deine Version | So gewollt; die neue Fassung liegt in `.factory/new/` zum Zusammenführen |

Alles, was die Fabrik entscheidet, steht im Journal (`~/controller/journal.ndjson`). Alles, was du entscheidest, kommt sofort in `docs/coordinator.md` und `docs/dev-workflow.md`.
