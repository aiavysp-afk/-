#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL securely to the dedicated application database}"
cd -- "$(dirname -- "$0")/.."
pnpm --filter @zydj/api exec prisma migrate deploy
pnpm --filter @zydj/api exec prisma migrate status
# No reset, db push or development seed. Run generate in the build phase.
