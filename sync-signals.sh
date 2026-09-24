#!/bin/bash
# Set VPS_HOST in your environment, e.g.: export VPS_HOST=root@your.vps.ip
: "${VPS_HOST:?Set VPS_HOST (e.g. root@your.vps.ip) before running}"
rsync -av "${VPS_HOST}:/opt/nexustrader/signals/" "$(dirname "$0")/signals/"
