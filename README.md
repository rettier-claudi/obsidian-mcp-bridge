# obsidian-mcp-bridge

An Obsidian plugin that serves a small MCP server over Streamable HTTP, so scripts
and automations outside Obsidian can act **through the running app** instead of
editing Markdown with regexes.

Two tools, nothing else: `complete_task` and `rename_file`.

## Why

Two jobs in this vault cannot be done correctly from outside Obsidian:

**Recurring tasks.** `tasks.py` in the vault ticks off recurring items (the daily
tDCS session and friends) by rewriting the line. It sets `[x]` and a `✅` date fine,
but it cannot create the next occurrence, because that logic — parsing `🔁 every
day`, rolling the `📅`/`⏳`/`🛫` dates forward with `rrule`, honouring
`removeScheduledDateOnRecurrence` and the user's line-order preference — lives in
the Tasks plugin's TypeScript (`src/Task/Recurrence.ts`, `src/Task/Occurrence.ts`)
and only runs inside Obsidian. Reimplementing it in Python would mean maintaining a
second, silently diverging copy of somebody else's date arithmetic. So instead of
reimplementing it, this plugin puts the cursor on the line and fires the Tasks
plugin's own command.

**Renaming.** Obsidian's `fileManager.renameFile()` rewrites every `[[wikilink]]`
and embed pointing at the file. A `mv` on disk, or `vault.rename()`, does not — it
leaves dangling links. Our scripts have been doing the `mv`.

Both cases are the same shape: the correct behaviour already exists inside
Obsidian, and the only thing missing was a way to reach it from outside.

### Why this name

It is not a fork and not a general "Obsidian API" — it is a narrow bridge between
MCP clients and one running Obsidian instance. Deliberately *not* a
`local-rest-api` style thing: there is no generic file access, no
`execute_any_command`, no browsing. Adding those would turn a two-purpose tool into
a remote shell over the vault.

## How it works

```
tasks.py / n8n / a Claude session
        │  POST /mcp   (MCP Streamable HTTP, Bearer token)
        ▼
Obsidian plugin  →  app.commands.executeCommandById('obsidian-tasks-plugin:toggle-done')
                 →  app.fileManager.renameFile(...)
```

`complete_task` opens the note in a Markdown leaf in source mode, makes that leaf
the active editor, puts the cursor on the target line, and runs the Tasks plugin's
**`obsidian-tasks-plugin:toggle-done`** command ("Toggle task done"). Then it reads
the buffer back, saves the file immediately, and returns the before/after lines so
the caller can see what the plugin actually did.

The active-editor dance is not optional: `toggle-done` is registered with
`editorCheckCallback`, so it acts on whatever editor Obsidian considers active and
does nothing at all if that is not a `MarkdownView`.

### Transport

Streamable HTTP, not stdio, because the callers are in other containers and on
other hosts. Stateless mode with `enableJsonResponse`, so a caller can be a single
`requests.post(...)`:

- **No `initialize` handshake needed.** Each request is served by a fresh MCP
  `Server`, so a bare `tools/call` works on its own.
- **No `Mcp-Session-Id` juggling.** No session ids are issued.
- Only `POST /mcp` is served. `GET`/`DELETE` return 405 — this server never pushes
  anything on its own, so there is no stream to open or session to tear down.
- `GET /health` is unauthenticated and returns `{"status":"ok"}` for container
  healthchecks. It says nothing about the vault.

### Security

Every request to `/mcp` must carry `Authorization: Bearer <token>`, compared in
constant time. The token lives in the plugin's `data.json` (Obsidian's normal place
for plugin config), is generated on first load, and is shown/regenerable in the
settings tab. It is deliberately **not** read from 1Password at runtime — in this
homelab 1Password is a backup store, not a runtime secret source.

The plugin refuses to start the listener without a token. The default bind address
is `0.0.0.0` because the point is cross-container access; set it to `127.0.0.1` if
you only need local calls, and do not expose the port beyond the homelab network —
this endpoint can rename anything in the vault.

## Build

```bash
npm install
npm run build      # typechecks, then bundles src/ into main.js
npm run test:smoke # HTTP layer, auth, MCP handshake, line resolution
npm run dev        # watch build
```

`main.js` is committed on purpose: deployment here is "copy three files onto a
host", not "run a build there".

`npm run test:smoke` covers everything that does not need a real Obsidian (auth,
routing, the MCP wire format, anchor/line resolution, the rename guards) against a
stubbed `obsidian` module. It cannot cover the leaf-opening or the real Tasks
command — see the TODOs below.

## Install

1. Copy `main.js`, `manifest.json` and `styles.css` into
   `<vault>/.obsidian/plugins/mcp-bridge/`.
2. Restart Obsidian (or reload it), then enable **MCP Bridge** under
   Settings → Community plugins.
3. Open the plugin's settings tab. A token has been generated already — copy it
   with the copy button, or paste your own. Adjust bind address and port if needed
   (default `0.0.0.0:27125`).
4. The listener starts on layout-ready. Check Settings → MCP Bridge, or run the
   command **"MCP Bridge: Show MCP server status"**, to confirm it is listening.
5. Make sure the port is reachable from wherever the caller lives — in the
   headless containers, the Obsidian container needs that port published.

The Tasks plugin (`obsidian-tasks-plugin`) must be installed and enabled in the
same vault, otherwise `complete_task` fails with "Command ... did not run".

## Calling it

Required headers: the bearer token, and `Accept: application/json,
text/event-stream` — the Streamable HTTP spec requires both media types in
`Accept` even though `enableJsonResponse` makes the answer plain JSON. Sending only
`application/json` gets a **406**.

### List the tools

```bash
curl -s http://mike:27125/mcp \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

### `complete_task`

Identify the line by block anchor (preferred), unique text, or 1-based line
number:

```bash
curl -s http://mike:27125/mcp \
  -H "Authorization: Bearer $OBSIDIAN_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
        "jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"complete_task",
                  "arguments":{"path":"Aufgaben/geplant.md","anchor":"t-abcd"}}
      }' | jq -r '.result.content[0].text' | jq
```

```json
{
  "ok": true,
  "path": "Aufgaben/geplant.md",
  "line_number": 3,
  "line_before": "- [ ] tDCS-Sitzung 🔁 every day 📅 2026-09-02 ^t-abcd",
  "lines_after": [
    "- [ ] tDCS-Sitzung 🔁 every day 📅 2026-09-03",
    "- [x] tDCS-Sitzung 🔁 every day 📅 2026-09-02 ✅ 2026-09-02 ^t-abcd"
  ],
  "recurrence_created": true,
  "changed": true,
  "command_id": "obsidian-tasks-plugin:toggle-done"
}
```

From Python:

```python
import requests

def call(tool, args, base="http://mike:27125/mcp", token=...):
    r = requests.post(base, timeout=30,
        headers={"Authorization": f"Bearer {token}",
                 "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": tool, "arguments": args}})
    r.raise_for_status()
    import json
    result = r.json()["result"]
    payload = json.loads(result["content"][0]["text"])
    if result.get("isError") or not payload.get("ok"):
        raise RuntimeError(payload.get("error", "unknown error"))
    return payload

call("complete_task", {"path": "Aufgaben/geplant.md", "anchor": "t-abcd"})
call("rename_file", {"from": "Notizen/alt.md", "to": "Archiv/neu.md"})
```

Note the two-level error convention: transport/protocol problems come back as HTTP
status codes or a JSON-RPC `error`; tool problems (file not found, anchor not
unique, line is not a task) come back as `isError: true` with
`{"ok": false, "error": "..."}` in the text content.

### `rename_file`

```json
{"name":"rename_file","arguments":{"from":"Notizen/alt.md","to":"Archiv/neu.md"}}
```

Works for folders too. Missing parent folders are created. It refuses to overwrite
an existing target.

## Behaviour worth knowing

- **The new recurrence instance has no block anchor.** Tasks explicitly sets
  `blockLink: ''` on the next occurrence ("New occurrences cannot have the same
  block link"). So a caller that tracks tasks by `^t-xxxx` will find the anchor on
  the *completed* line and nothing on the new open one — it has to mint a fresh
  anchor itself if it wants to track the follow-up. `lines_after` in the response
  contains both lines so the caller can do that.
- **The line ordering depends on user settings.** Tasks uses
  `toggleWithRecurrenceInUsersOrder()`; whether the new instance lands above or
  below the completed one is a Tasks setting, not something this plugin controls.
  Do not assume an order — read `lines_after`.
- **Non-task lines are refused.** Tasks' toggle command will happily convert a
  plain text line into a checklist item. This plugin checks the target line looks
  like `- [ ] ...` first and errors out otherwise, so a mis-addressed call cannot
  silently reshape a paragraph.
- **Ambiguity is an error.** A non-unique anchor or `line_text` matching several
  lines fails rather than picking one.
- **The file is saved immediately** (`view.save()`), not left to Obsidian's
  multi-second autosave, because callers read the file back right away.
- The note stays open in a leaf afterwards. That is harmless in a headless
  instance, and keeps repeated calls on the same file fast.

## Open TODOs — must be verified live (phase 2)

Nothing here has run against a real Obsidian yet. In rough order of risk:

1. **Does the leaf actually open and become the active editor under Xvfb?** The
   whole design rests on `workspace.getLeaf()` + `openFile()` +
   `setActiveLeaf({focus: true})` producing an editor that
   `executeCommandById` will act on, in an instance nobody is looking at. If
   `toggle-done` returns `true` but nothing changes, this is the suspect: the
   command dispatched but found no active `MarkdownView`. The response's
   `changed: false` is the signal.
2. **Is the 50 ms wait after `openFile()` enough** for CodeMirror to attach on a
   cold, headless start? If `complete_task` intermittently errors with "could not
   open ... in a Markdown editor", raise it. It is a fixed sleep, which is the
   crude solution; if it proves flaky, replace it with polling for
   `view.editor` rather than just a longer sleep.
3. **Confirm the command id on the installed version.** Built against
   `obsidian-tasks-plugin` sources at tag `8.3.0` (the version on `mike-obsidian`)
   and current `main`; both register `id: 'toggle-done'` inside
   `src/Commands/index.ts`, which Obsidian namespaces to
   `obsidian-tasks-plugin:toggle-done`. Verify in the running instance via the
   command palette or `app.commands.commands` in the dev console. The id is a
   plugin setting, so a mismatch is a settings fix, not a rebuild.
4. **Confirm recurrence actually fires.** `mike-obsidian` has no `data.json` for
   Tasks yet, so all settings are defaults (`removeScheduledDateOnRecurrence:
   false`). Complete one real `🔁` task and check `lines_after` has two entries
   and the dates rolled forward as expected.
5. **Does `view.save()` land before the caller reads the file?** It is awaited,
   but confirm against `fast-note-sync` — a save and a sync write racing on the
   same file is exactly the shape of the earlier task-loss incident.
6. **Port reachability.** The port has to be published from the Obsidian
   container, and the `obsidian-docker` image/compose does not do that yet.
7. **Restart survival.** Confirm the listener comes back after an Obsidian restart
   inside the container, and that a stale listener does not block the port
   (`EADDRINUSE` shows up as "not running — ..." in the settings tab).

## Layout

```
src/main.ts      plugin lifecycle, server start/stop
src/server.ts    HTTP listener, bearer auth, MCP server + tool definitions
src/actions.ts   the two vault operations
src/settings.ts  settings tab
test/            smoke test against a stubbed obsidian module
```

## Licence

MIT.
