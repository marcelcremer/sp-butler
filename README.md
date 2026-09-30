# SP Butler

Plugin für [Super Productivity](https://super-productivity.com), mit dem sich Aufgaben in natürlicher Sprache verwalten lassen. Es spricht mit jedem **OpenAI-kompatiblen Endpoint** (`/chat/completions` mit Tool-Calling, optional `/embeddings` und `/rerank`).

## Stufe 1 – Funktionen

| Anwendungsfall | Beispiel | Tools |
| --- | --- | --- |
| Tasks in natürlicher Sprache anlegen | „Morgen Reifenwechsel, 30 Minuten, Projekt Auto“ | `propose_create_tasks` |
| Brain-Dump zerlegen | Absatz einfügen → mehrere Tasks mit Subtasks | `propose_create_tasks` |
| Fragen an die Liste | „Was ist diese Woche fällig?“, „Was liegt im Projekt X noch offen?“ | `search_tasks`, `get_task` |
| Bulk-Änderungen | „Schieb alles von heute auf Freitag“, „Markiere die drei Einkaufstasks als erledigt“ | `search_tasks` → `propose_update_tasks` |

Unterstützte Felder: Titel, Projekt, Tags, Notizen, Zeitschätzung, Fälligkeitstag, Parent (Subtasks), dazu Erledigt-Status und Projektwechsel.

**Nichts wird ohne Bestätigung geändert.** Schreibende Tools erzeugen nur einen *Vorschlag*. Die UI zeigt ihn als Liste mit Checkboxen (Diff bei Änderungen). Erst „Übernehmen“ führt die ausgewählten Einträge aus.

## Installation

```bash
npm ci
npm run build        # → dist/sp-butler-<version>.zip
```

In Super Productivity: **Einstellungen → Plugins → Plugin-Datei wählen** und die ZIP hochladen. Danach das Panel „SP Butler“ in der rechten Seitenleiste öffnen, dort unter *Einstellungen* konfigurieren:

| Einstellung | Standard | Hinweis |
| --- | --- | --- |
| Base-URL | `https://ai-2.1nt.eu/v1` | beliebiger OpenAI-kompatibler Endpoint |
| API-Key | – | lokal im Secret-Storage, **wird nicht synchronisiert** oder exportiert |
| Chat-Modell | – | Pflicht, muss Tool-Calling können |
| Embedding-Modell | – | optional, aktiviert semantische Suche |
| Rerank-Modell | – | optional, verbessert die Trefferreihenfolge |
| Temperatur / Max. Tool-Runden / Timeout | 0.2 / 8 / 90 s | |
| Eigene Anweisungen | – | z. B. „Einkäufe immer ins Projekt Haushalt“ |

„Verbindung testen & Modelle laden“ ruft `/models` auf und füllt die Modell-Vorschläge.

Zusätzlich gibt es den Shortcut **„SP Butler öffnen“**. Die Taste dafür legt man unter Einstellungen → Tastenkürzel → Plugin Shortcuts fest.

### CORS

Die Anfragen gehen per `fetch` direkt aus der App (Web/Desktop). Der Endpoint muss daher CORS erlauben (`Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type`). LiteLLM, vLLM und Ollama können das bzw. tun es standardmäßig. Schlägt die Verbindung mit „Netzwerkfehler“ fehl, ist fehlendes CORS die wahrscheinlichste Ursache.

Warum nicht `PluginAPI.request`? Der Host erlaubt dort nur Hosts, die fest im `allowedHosts` des Manifests stehen. Eine frei konfigurierbare Base-URL wäre damit nicht möglich, und im Browser gilt CORS dort genauso.

## Architektur

```
┌──────────── index.html (iframe, Seitenpanel) ────────────┐
│ Chat · Vorschlagskarten · Einstellungen                   │
└──────────────┬────────────────────────────────────────────┘
               │ postMessage (PLUGIN_MESSAGE → PluginAPI.onMessage)
┌──────────────▼──────────── plugin.js (Host) ──────────────┐
│ main.ts      Nachrichten-Router, Shortcut, Sync-Hook       │
│ butler.ts    Tool-Calling-Schleife, Sessions, Verlauf      │
│ prompt.ts    System-Prompt inkl. Kalender, Projekte, Tags  │
│ tools.ts     search_tasks · get_task · propose_* (nur Vorschlag) │
│ proposal.ts  Vorschlag sammeln → nach Bestätigung anwenden │
│ search.ts    Filter + Keyword → Embeddings → Rerank        │
│ llm-client.ts  /chat/completions · /embeddings · /rerank · /models │
│ settings.ts  Einstellungen (synced) + API-Key (Secret)     │
└────────────────────────────────────────────────────────────┘
```

Designentscheidungen:

- **LLM-Aufrufe in `plugin.js`, nicht im iframe.** Nur der Host-Teil hat Zugriff auf `getSecret`. Der API-Key erreicht die UI daher nie.
- **Kurze Task-Referenzen** (`t1`, `t2`, …) statt der langen IDs. Das spart Tokens, und Tippfehler des Modells fallen auf (unbekannte Ref → Fehler ans Modell, das sich korrigiert).
- **Kalender im Prompt.** Die nächsten 14 Tage stehen mit Wochentag im Prompt („2026-10-02 Freitag“). LLMs rechnen Wochentage oft falsch.
- **Semantische Suche baut stufenweise auf.** Ohne Modelle gibt es Stichwortsuche mit Präfix-Matching („Einkauf“ ≈ „einkaufen“). Mit Embedding-Modell kommt Cosinus-Ähnlichkeit hinzu (Vektoren pro Task gecacht), mit Rerank-Modell eine Neusortierung der Top 40. Fällt ein Endpoint aus, arbeitet die vorherige Stufe weiter.
- **Verschieben mit Uhrzeit.** Tasks mit fester Uhrzeit (`dueWithTime`) behalten beim Verschieben ihre Uhrzeit.
- **Robust gegen Modellfehler.** Tool-Argumente werden validiert. Fehler gehen als Tool-Ergebnis zurück ans Modell, bei Bulk-Änderungen einzeln pro Eintrag.

## Entwicklung

Abhängigkeiten sind bewusst klein: nur `typescript`, `esbuild`, `eslint` und `typescript-eslint` (plus `@types/node`). Tests laufen mit dem eingebauten `node:test`. Node ≥ 22.18 führt TypeScript direkt aus, ein Test-Framework oder Loader ist nicht nötig. Die ZIP erzeugt ein kleiner eigener Writer auf Basis von `node:zlib`.

```bash
npm run typecheck   # tsc (strict)
npm run lint        # eslint, typescript-eslint strictTypeChecked
npm test            # node --test
npm run build       # dist/sp-butler/ + ZIP
npm run check       # alles zusammen (läuft auch in CI)
```

Die Plugin-API-Typen liegen in `src/types/plugin-api.ts`. Das npm-Paket `@super-productivity/plugin-api` (1.0.1) ist älter als Secret-Storage, deshalb ist die benötigte Teilmenge aus dem Upstream-Repo übernommen.

Zum Ausprobieren ohne echte Daten eignet sich <https://test-app.super-productivity.com/>.

## Ideen für die nächsten Stufen

- **Löschen und Umstrukturieren**: `deleteTask` und Subtasks verschieben über `batchUpdateForProject`, mit extra deutlicher Bestätigung.
- **Kontextmenü „Mit Butler bearbeiten“** (`registerTaskContextMenuEntry`): Task zerlegen, schätzen oder umformulieren.
- **Tagesplanung**: „Plane meinen Tag mit 6 Stunden Kapazität“ auf Basis von Schätzungen, Fälligkeiten und `timeSpent`.
- **Wiederkehrende Tasks** (`taskRepeatCfgs` aus `getAppState`) lesen und in Antworten berücksichtigen.
- **Archiv durchsuchen** (`getArchivedTasks`): „Wann habe ich zuletzt die Reifen gewechselt?“
- **Streaming** der Antworten und ein Abbrechen-Button.
- **Chatverlauf behalten** (`persistDataSynced` pro Gerät) und i18n der UI (Englisch).
- **Auto-Apply-Option** für einzelne, eindeutige Neuanlagen.
