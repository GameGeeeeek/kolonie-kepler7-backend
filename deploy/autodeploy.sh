#!/bin/bash
# The existing cron now enters the same archive/lock/pending/restart path as
# the signed webhook. The private socket accepts only this fixed backend target.
set -euo pipefail
exec /usr/bin/docker exec kepler7-backend node /app/operations-release-guard.js autodeploy
