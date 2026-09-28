# CornerstoreAI

Tagesaktuelle Einkaufspreise für deinen Späti: Supermarkt-Angebote (automatisch), Großhändler- und Herstellerpreise (von dir) – alles in einer App.

| Datei / Ordner | Wofür |
|---|---|
| `index.html`, `style.css`, `app.js` | Die App selbst |
| `config.js` | **Hier trägst du deine Supabase-Daten ein** |
| `manifest.webmanifest`, `sw.js`, `icons/` | Damit man die App aufs Handy installieren kann |
| `supabase/schema.sql` | Einmal in Supabase ausführen: legt die Datenbank an |
| `collector/collect.py` | Holt jeden Morgen die Angebote (läuft automatisch bei GitHub) |
| `.github/workflows/preise.yml` | Der Zeitplan für den Preisabruf |

Die komplette Schritt-für-Schritt-Anleitung bekommst du von Claude als eigenes Dokument.

Test ohne Internet: `python collector/collect.py --demo`
