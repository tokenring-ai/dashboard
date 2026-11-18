# @tokenring-ai/dashboard

Persists per-user dashboard layouts for the TokenRing One web frontend.

The frontend's layout engine (`frontend/src/layout/`) serialises each app's layout
to an opaque JSON document, and user-saved apps are stored as records with an
`app` field. This plugin stores those documents as
`<workspace>/dashboards/<user>/<dashboardId>.json` and exposes them over the
`/rpc/dashboard` endpoint (`getDashboardLayout`, `saveDashboardLayout`,
`deleteDashboardLayout`, `listDashboardLayouts`). Records carry the client's
layout schema version and view-registry hash so the frontend knows when to
re-validate a stored layout, and `saveDashboardLayout` supports optimistic
concurrency through `expectedUpdatedAt`.

Layouts are keyed by the authenticated username of the WebSocket session
(see `RpcCallContext`); unauthenticated in-process callers share the `default`
scope.

## Chat Commands

This package does not define any chat commands.

## Tools

This package does not define any agent tools.
