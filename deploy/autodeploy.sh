#!/bin/bash
# Auto-Pull für den kepler7-backend Docker-Container auf dem Pi (CasaOS).
# Ersetzt den bisher rein manuellen Deploy-Schritt ("Sascha zieht und startet per SSH neu").
#
# Verifiziertes Setup (19.07.2026, per docker inspect auf dem echten Pi geprüft):
#   - /DATA/kepler7/backend ist per Bind-Mount als /app im Container eingehängt (kein COPY im
#     Dockerfile, kein Image-Rebuild nötig für Code-Änderungen).
#   - Container-Startbefehl: "npm install && npx nodemon --watch . --ext js,json server.js"
#     -> nodemon beobachtet bereits selbst .js/.json-Änderungen in /app und startet server.js
#        automatisch neu, SOBALD sich eine Datei im Bind-Mount ändert. Ein reines "git pull" auf
#        dem Host reicht also in den allermeisten Fällen - kein docker restart nötig!
#   - Einzige Ausnahme: package.json/package-lock.json geändert (neue Abhängigkeit). nodemon
#     erkennt zwar auch diese Änderung (sie matcht "--ext json") und startet server.js neu, führt
#     dabei aber KEIN erneutes "npm install" aus (das läuft nur einmal beim Containerstart) - neue
#     Abhängigkeiten fehlen dann trotzdem. Deshalb in diesem Fall zusätzlich docker restart.
#
# EINRICHTUNG (einmalig, per SSH auf dem Pi):
#   1. chmod +x deploy/autodeploy.sh
#   2. Testlauf von Hand: ./deploy/autodeploy.sh   (sollte "Kein Update" ausgeben, wenn nichts neu ist)
#   3. Per Cron alle 5 Minuten laufen lassen: crontab -e und folgende Zeile einfügen:
#        */5 * * * * /DATA/kepler7/backend/deploy/autodeploy.sh >> /DATA/kepler7/backend/deploy/autodeploy.log 2>&1
#
# Sicherheitshinweis: Damit geht JEDER Push nach master ohne manuellen Zwischenschritt live,
# inklusive KI-generierter Änderungen. Wer das nicht will, lässt Schritt 3 (Cron) weg und ruft
# das Skript stattdessen von Hand auf, wenn ein Release geprüft und freigegeben wurde.

set -euo pipefail

REPO_DIR="/DATA/kepler7/backend"
CONTAINER_NAME="kepler7-backend"
BRANCH="master"

cd "$REPO_DIR"

BEFORE=$(git rev-parse HEAD)
git fetch origin "$BRANCH" --quiet
AFTER=$(git rev-parse "origin/$BRANCH")

if [ "$BEFORE" = "$AFTER" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') Kein Update (HEAD=$BEFORE)."
  exit 0
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Update gefunden: $BEFORE -> $AFTER. Ziehe..."
git pull origin "$BRANCH" --quiet

if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^package(-lock)?\.json$'; then
  echo "package.json/package-lock.json geändert - starte Container neu (npm install muss erneut laufen)."
  docker restart "$CONTAINER_NAME"
else
  echo "Nur server.js/sonstiger Code geändert - nodemon im Container übernimmt den Neustart selbst."
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Deploy abgeschlossen (jetzt auf $AFTER)."
