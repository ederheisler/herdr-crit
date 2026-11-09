# 0003: URL-free Application handoff

## Context

The live review type asked the user to paste an app URL.
Crit's live mode can fail when the Crit page origin and the injected origin differ, for example `localhost` and `127.0.0.1`. The `agent-ready` message is then dropped.

## Decision

The owner chose an Application mode (id `live`) with no URL entry.
The selected existing agent reuses the project app, or starts it with the project commands, and discovers the actual URL.
The agent reports the URL to the bridge, which launches `crit live` with it.
The app keeps its real origin. The Crit UI opens at `localhost:<Crit port>/live` to avoid the reported origin mismatch.
The agent must verify in the browser that Comment mode is ready, and refer to the Crit live mode documentation if it is not.
The mod does not change CSP, framing, or other browser security.

## Rationale

Avoid requiring the user to paste a URL and guard against the reported Crit origin mismatch.
