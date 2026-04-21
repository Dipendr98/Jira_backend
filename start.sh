#!/bin/sh
set -e

echo "==> Running database migrations..."
if /app/node_modules/.bin/prisma migrate deploy; then
  echo "==> Migrations applied successfully."
else
  echo "==> WARNING: Migration failed. DATABASE_URL may not be set or the database is unreachable."
  echo "==> Continuing startup – set DATABASE_URL in Railway environment variables and redeploy."
fi

echo "==> Starting server..."
exec node /app/dist/app.js
