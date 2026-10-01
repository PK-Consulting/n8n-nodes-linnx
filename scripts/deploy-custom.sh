#!/usr/bin/env bash
# Copy the built node into a self-hosted n8n's custom folder (Docker) and restart it.
# For testing before anything is on npm. Restarting takes n8n down for about 30 seconds.
#
#   N8N_HOST=root@1.2.3.4 N8N_CONTAINER=n8n-n8n-1 scripts/deploy-custom.sh
set -euo pipefail

HOST="${N8N_HOST:?set N8N_HOST, e.g. root@1.2.3.4}"
CONTAINER="${N8N_CONTAINER:-n8n-n8n-1}"
TARGET=/home/node/.n8n/custom/n8n-nodes-linnx

cd "$(dirname "$0")/.."
npm run build >/dev/null
tar -C dist --exclude='*.map' --exclude='*.d.ts' --exclude='*.tsbuildinfo' -czf /tmp/linnx-dist.tgz nodes credentials icons
scp -q /tmp/linnx-dist.tgz "$HOST:/tmp/linnx-dist.tgz"
rm /tmp/linnx-dist.tgz

ssh "$HOST" bash -s <<EOF
set -euo pipefail
rm -rf /tmp/linnx && mkdir -p /tmp/linnx/n8n-nodes-linnx
tar -xzf /tmp/linnx-dist.tgz -C /tmp/linnx/n8n-nodes-linnx
docker exec -u root $CONTAINER rm -rf $TARGET
docker exec $CONTAINER mkdir -p /home/node/.n8n/custom
docker cp /tmp/linnx/n8n-nodes-linnx $CONTAINER:/home/node/.n8n/custom/
docker exec -u root $CONTAINER chown -R node:node /home/node/.n8n/custom
rm -rf /tmp/linnx /tmp/linnx-dist.tgz
docker restart $CONTAINER >/dev/null
for i in \$(seq 1 30); do sleep 3; curl -sf localhost:5678/healthz >/dev/null && break; done
echo "n8n: \$(curl -s localhost:5678/healthz)"
EOF
