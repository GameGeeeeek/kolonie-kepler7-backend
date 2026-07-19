#!/bin/bash
# Auto-Pull + Neustart für den kepler7-backend Docker-Container auf dem Pi (CasaOS).
# Ersetzt den bisher rein manuellen Deploy-Schritt ("Sascha zieht und startet per SSH neu").
#
# EINRICHTUNG (einmalig, per SSH auf dem Pi):
#   1. REPO_DIR unten auf das tatsächliche Repo-Verzeichnis auf dem Pi anpassen.
#   2. Vorher herausfinden, ob der Container über docker-compose läuft (das Skript erkennt es
#      zwar selbst automatisch, zur Sicherheit trotzdem vorab prüfen):
#        docker inspect kepler7-backend --format '{{ index .Config.Labels "com.docker.compose.project" }}'
#      Leere Ausgabe = kein Compose (reiner "docker run"/CasaOS-App), sonst = Compose-Projektname.
#   3. chmod +x deploy/autodeploy.sh
#   4. Testlauf von Hand: ./deploy/autodeploy.sh   (sollte "Kein Update" ausgeben, wenn nichts neu ist)
#   5. Per Cron alle 5 Minuten laufen lassen: crontab -e und folgende Zeile einfügen:
#        */5 * * * * /pfad/zu/kolonie-kepler7-backend/deploy/autodeploy.sh >> /pfad/zu/kolonie-kepler7-backend/deploy/autodeploy.log 2>&1
#
# Sicherheitshinweis: Damit geht JEDER Push nach master ohne manuellen Zwischenschritt live,
# inklusive KI-generierter Änderungen. Wer das nicht will, lässt Schritt 5 (Cron) weg und ruft
# das Skript stattdessen von Hand auf, wenn ein Release geprüft und freigegeben wurde.

set -euo pipefail

REPO_DIR="/pfad/zu/kolonie-kepler7-backend"   # <-- ANPASSEN
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

echo "$(date '+%Y-%m-%d %H:%M:%S') Update gefunden: $BEFORE -> $AFTER. Ziehe und starte neu..."
git pull origin "$BRANCH" --quiet

# Node-Abhängigkeiten könnten sich geändert haben (package.json/package-lock.json).
NEEDS_NPM_INSTALL=0
if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^package(-lock)?\.json$'; then
  echo "package.json/package-lock.json geändert – Abhängigkeiten müssen neu installiert werden."
  NEEDS_NPM_INSTALL=1
fi

if docker inspect "$CONTAINER_NAME" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null | grep -q .; then
  # Compose-Setup (u.a. das, was CasaOS meist generiert).
  COMPOSE_DIR=$(docker inspect "$CONTAINER_NAME" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}')
  echo "Erkanntes Compose-Setup in $COMPOSE_DIR"
  if [ "$NEEDS_NPM_INSTALL" = "1" ]; then
    (cd "$COMPOSE_DIR" && docker compose build --no-cache "$CONTAINER_NAME")
  fi
  (cd "$COMPOSE_DIR" && docker compose up -d --force-recreate "$CONTAINER_NAME")
else
  # Reiner "docker run"/CasaOS-App ohne Compose-Label: Container einfach neu starten.
  # Setzt voraus, dass der Code per Bind-Mount ins Image eingebunden ist (kein eigenes Image-Build
  # nötig) - falls stattdessen ein eigenes Image gebaut wird, muss hier noch ein "docker build"
  # ergänzt werden (auf dem Pi prüfen und diesen Kommentar dann durch den echten Ablauf ersetzen).
  if [ "$NEEDS_NPM_INSTALL" = "1" ]; then
    docker exec "$CONTAINER_NAME" npm install --omit=dev --prefix /app || \
      echo "WARNUNG: npm install im Container fehlgeschlagen (Pfad /app evtl. falsch) - manuell prüfen."
  fi
  docker restart "$CONTAINER_NAME"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Deploy abgeschlossen (jetzt auf $AFTER)."
