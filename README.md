# Blutdruck-Tagebuch – PWA (GitHub Pages)

Statische, installierbare Web-App für iPhone und PC. Die HTML-, CSS-, JavaScript- und Icon-Dateien sind öffentlich; persönliche Messwerte gehören **nicht** ins Repository.

## Datenschutz und Betrieb

- Alle eingetragenen Messwerte werden ausschließlich lokal im Browser/der installierten Web-App (IndexedDB, bei Bedarf lokaler Ersatzspeicher) gespeichert. Es gibt keine Datenübertragung der Messwerte, kein Tracking und kein Backend.
- Der Service Worker speichert die App-Dateien offline; die Messwerte liegen unabhängig davon in der lokalen Datenbank.
- Der optionale Passwortschutz verschlüsselt den lokal gespeicherten Datenbestand.
- **Nicht absolut verlustsicher:** Durch Löschen von Browserdaten/App, Geräteverlust oder iOS-Speicherverwaltung können Werte verloren gehen. Regelmäßig per **Sicherung speichern** eine verschlüsselte Sicherung exportieren und separat aufbewahren.
- Speicher zwischen Geräten wird **nicht** synchronisiert. Jede Installation hat eine eigene lokale Datenbank.

## Installation auf iPhone

1. Veröffentlichten GitHub-Pages-Link in **Safari** öffnen (HTTPS).
2. Teilen → **Zum Home-Bildschirm** → Hinzufügen.
3. App vom Home-Bildschirm starten. Die Oberfläche kann nach dem ersten Laden auch ohne Internet benutzt werden.
4. Bestehende Messwerte nur über **Sicherung speichern** (alte App) und **Sicherung öffnen** (neue App) übertragen.

## Veröffentlichung

In einem separaten öffentlichen Repository: GitHub → Settings → Pages → Deploy from a branch → `main`, `/ (root)`.
Alle Inhalte dieses Ordners (einschließlich `index.html`) in den Repository-Stamm legen.
Keine JSON-Sicherungen, Screenshots mit Gesundheitsdaten oder persönlichen Dateien hochladen.

## Drucken

Eine Kalenderwoche (Montag–Sonntag) pro A4-Blatt, Schwarz-Weiß. In Safari/Browser Druck-Kopf-/Fußzeilen deaktivieren, soweit angeboten.
