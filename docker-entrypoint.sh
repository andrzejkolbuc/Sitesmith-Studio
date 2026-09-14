#!/bin/sh
set -e

# Apply migrations, then run whatever the container was asked to run.
#
# Migration is a precondition, not a step someone remembers: a container that
# serves against an unmigrated database is worse than one that refuses to start,
# so a failed migration exits non-zero and the command never runs.
#
# `exec "$@"` rather than a hardcoded `node server.js` is what makes
# `docker run <image> node scripts/check-browser.mjs` mean anything. Without it
# those words are handed to a script that ignores them and the server starts
# instead — so the browser check would silently test nothing. `exec` also makes
# the command PID 1, so it receives signals directly.

if [ -n "$DATABASE_URL" ]; then
	node scripts/migrate.mjs
else
	# No URL means nobody asked for a database — the browser check runs this way,
	# before any composition exists. An *unreachable* URL is a different thing and
	# still fails loudly above.
	echo "entrypoint: DATABASE_URL is not set; skipping migrations." >&2
fi

exec "$@"
