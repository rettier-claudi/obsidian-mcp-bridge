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
leaves dangling links. Our scripts have been doing the `mv`. (It only rewrites
links if the vault has "Automatically update internal links" on — see
[below](#alwaysupdatelinks-is-a-hard-requirement-not-a-preference).)

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
        │  POST /mcp   (MCP Streamable HTTP, plain shared-secret header)
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

Every request to `/mcp` must carry `X-Bridge-Token: <token>`, compared in constant
time. Deliberately not `Authorization: Bearer` — that scheme, paired with a
`WWW-Authenticate` response, is what the MCP authorization spec uses to tell a
compliant client "go do OAuth discovery here." This server doesn't implement OAuth
and doesn't want a client attempting it: a private, static pre-shared secret needs
no authorization server, no discovery endpoint, no network round-trip beyond the
request itself — fewer moving parts for a vault-local tool. A plain custom header
keeps that intent unambiguous.

The token lives in the plugin's `data.json` (Obsidian's normal place for plugin
config), is generated on first load, and is shown/regenerable in the settings tab.
It is deliberately **not** read from 1Password at runtime — in this homelab
1Password is a backup store, not a runtime secret source.

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
command — those were checked by hand against the running instances, see
[Verified live](#verified-live-2026-09-03).

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
5. Make sure the port is reachable from wherever the caller lives. On macvlan
   containers (the setup here) the container has its own LAN address and nothing
   needs publishing; on bridge networking the port has to be published.
6. **Turn on Settings → Files & Links → "Automatically update internal links"**
   (`alwaysUpdateLinks: true` in `.obsidian/app.json`). This is not optional for
   `rename_file` — see below.

The Tasks plugin (`obsidian-tasks-plugin`) must be installed and enabled in the
same vault, otherwise `complete_task` fails with "Command ... did not run".

### `alwaysUpdateLinks` is a hard requirement, not a preference

`app.fileManager.renameFile()` is documented as updating links "depending on the
user's preferences". What the docs do not say is what happens when the preference
is off: Obsidian asks, with a modal — and the promise `renameFile()` returned does
not settle until somebody answers it. In a headless instance nobody ever does.

Observed on both containers, 2026-09-03, with `app.json` at `{}` (default):
the file **was** moved on disk, the `[[wikilinks]]` were **not** rewritten, and the
HTTP request never returned (still hanging after 180 s). Worse, the unanswered
modal blocks the next rename too, so every following `rename_file` hangs without
doing anything, and one instance eventually died and was restarted by its
supervisor. With `alwaysUpdateLinks: true` the same call returns in ~20 ms and
rewrites plain links, aliased links and embeds.

This is a settings fix, not a code fix, but it is invisible from the outside, so
check it first if `rename_file` ever hangs again.

## Calling it

Required headers: the token, and `Accept: application/json,
text/event-stream` — the Streamable HTTP spec requires both media types in
`Accept` even though `enableJsonResponse` makes the answer plain JSON. Sending only
`application/json` gets a **406**.

### List the tools

```bash
curl -s http://obsidian.mike.graz.philipp.ninja:27125/mcp \
  -H "X-Bridge-Token: $OBSIDIAN_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

### `complete_task`

Identify the line by block anchor (preferred), unique text, or 1-based line
number:

```bash
curl -s http://obsidian.mike.graz.philipp.ninja:27125/mcp \
  -H "X-Bridge-Token: $OBSIDIAN_MCP_TOKEN" \
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
    "- [ ] tDCS-Sitzung 🔁 every day 📅 2026-09-03 ^t-91fe",
    "- [x] tDCS-Sitzung 🔁 every day 📅 2026-09-02 ✅ 2026-09-02 ^t-abcd"
  ],
  "recurrence_created": true,
  "anchor_added": "t-91fe",
  "changed": true,
  "command_id": "obsidian-tasks-plugin:toggle-done"
}
```

From Python:

```python
import requests

def call(tool, args, base="http://obsidian.mike.graz.philipp.ninja:27125/mcp", token=...):
    r = requests.post(base, timeout=30,
        headers={"X-Bridge-Token": token,
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

- **The new recurrence instance gets a fresh block anchor from this plugin, not
  from Tasks.** Tasks itself sets `blockLink: ''` on the next occurrence ("New
  occurrences cannot have the same block link"), so the completed line keeps the
  original `^t-xxxx` and the new open line would otherwise have none —
  unaddressable by anchor, invisible to anything (like `tasks.py`) that tracks
  tasks by id. This plugin finds that line — the one still open (`[ ]`) and
  without a trailing anchor — and mints and appends a new `t-xxxx` id in the same
  format `tasks.py`'s own `neue_id()` uses, checked for collisions against the
  live buffer plus `tasks/offen.md`, `tasks/einkauf.md`, `tasks/erledigt.md`. The
  minted id comes back as `anchor_added` (`null` if nothing new was created).
- **The line ordering depends on user settings**, so the anchor logic does not
  assume a position. Tasks uses `toggleWithRecurrenceInUsersOrder()`; whether the
  new instance lands above or below the completed one is a Tasks setting. The
  new-occurrence line is identified by being open and unanchored, wherever it
  landed — read `lines_after` if the caller needs to know the order too.
- **`⏰` (time) and `⏱` (duration) — `tasks.py`'s own non-Tasks fields — are
  stripped before the toggle and put back on both resulting lines afterward.**
  Confirmed live 2026-09-04: their mere presence on a `🔁` line makes Tasks'
  `toggle-done` silently skip creating the recurrence at all — checkbox and `✅`
  ticked, no error, no next occurrence, `recurrence_created: false`. Not a
  caching issue (survived a full container restart) and not about `➕`, which is
  harmless alone — isolated to exactly these two fields by an A/B test against a
  live instance. `custom_fields_preserved` in the result lists what was moved
  (empty if the line had neither). Only these two are handled; nothing else has
  been shown to cause this, and guessing at more would risk mangling a line for
  a problem that was never confirmed.
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

## Verified live (2026-09-03, updated 2026-09-04)

Everything below was checked against the two headless instances that run the
plugin — `mike-obsidian` (`obsidian.mike.graz.philipp.ninja`, 192.0.0.238) and
`claudi-obsidian` (192.0.0.245), both Obsidian 1.13.7, Tasks 8.3.0, both on
macvlan with their own LAN address, port 27125. The 2026-09-03 pass used a
throwaway note with `🔁 every day` lines in `tasks.py`'s own format, not real
tasks. Item 10 below is from 2026-09-04, against Philipp's actual tDCS task.

**Confirmed working**

1. **The leaf opens and becomes the active editor under Xvfb.** `complete_task`
   returns `changed: true` and the file really changes. The whole
   `getLeaf()` + `openFile()` + `setActiveLeaf({focus: true})` dance survives an
   instance nobody is looking at.
2. **The 50 ms wait is enough, including on a cold start.** Four back-to-back
   `complete_task` calls fired 14 s after a `podman restart` (SIGKILL, so a truly
   cold Electron) all succeeded, ~135 ms each, no "could not open ... in a
   Markdown editor". No flakiness seen across roughly a dozen calls on both
   hosts. Leaving it as a fixed sleep for now; if it ever does show up, polling
   for `view.editor` is still the better fix.
3. **The command id is right.** Responses come back with
   `command_id: "obsidian-tasks-plugin:toggle-done"` and the line is actually
   toggled, so the id resolves on the installed Tasks 8.3.0. No dev console
   needed to establish that.
4. **Recurrence fires.** `lines_after` has two entries, `recurrence_created:
   true`, and the date rolls forward:

   ```
   before: - [ ] … 🔁 every day ➕2026-09-03 📅2026-09-03 ^t-9f01
   after:  - [ ] … 🔁 every day 📅 2026-09-04 ^t-84e7
           - [x] … 🔁 every day ➕ 2026-09-03 📅 2026-09-03 ✅ 2026-09-03 ^t-9f01
   ```

   Neither instance has a `data.json` for Tasks, so this is Tasks' default
   settings. Note the new occurrence **loses the `➕` created date** — that is
   Tasks' own behaviour, not something this plugin can fix from here. `tasks.py`
   parses the line fine (it reads `added` but never uses it), so this is
   cosmetic, but it does mean a recurring task drifts out of the vault
   convention that every task carries `➕`.
5. **The minted anchor round-trips.** `anchor_added` was set on every recurrence
   (`t-84e7`, `t-bb59`, `t-e97c`, `t-8036`, `t-797b`, `t-4194`), each one landed
   on disk on the still-open line, and `tasks.py`'s `TASK_RE`, `ID_RE` and
   `parse_line()` accept the resulting lines unchanged — no stray double space,
   anchor last, both the new and the completed line parse to the right id.
6. **`view.save()` lands before the caller reads the file, and there is no race
   with `fast-note-sync`.** The change was already on disk in *both* vault copies
   — the local one and the one on the other host — by the time the HTTP response
   had been read, well under a second. Re-reading after 8 s and after 25 s showed
   the same content, and no conflict or merge artefacts appeared in either vault.
   A rename done on one host propagated to the other, old path gone and links
   rewritten on both sides, within 3 s.
7. **Port reachability — the old TODO was based on a wrong assumption.** It
   assumed bridge networking. Both containers are on macvlan with their own LAN
   address, so there is nothing to publish and `podman port` is empty on purpose.
   `/health` answers from three different hosts in the LAN (mike, spathi and
   192.0.0.200), so this is settled. `obsidian.mike.graz.philipp.ninja` resolves
   to the mike container; spathi's has no DNS name yet, use 192.0.0.245.
8. **Restart survival.** After `podman restart` (which needed a SIGKILL both
   times) `/health` answered again within about 4 s and `complete_task` worked
   immediately after. No `EADDRINUSE`, no stale listener. Same after the instance
   died on its own and the supervisor brought it back.

**Found broken, and fixed by a setting**

9. `rename_file` hung forever and did not rewrite links, on both hosts, because
   `alwaysUpdateLinks` was not set. See
   [the section above](#alwaysupdatelinks-is-a-hard-requirement-not-a-preference).
   Both instances now have `.obsidian/app.json` set to `{"alwaysUpdateLinks":
   true}`; after that, renaming a note — including into a folder that has to be
   created — rewrites plain links, aliased links and embeds, in ~20 ms.
10. **`⏰`/`⏱` silently suppressed recurrence on Philipp's real tDCS task** —
    found the hard way, live, on the first real (non-test) use of `complete_task`
    after phase 2 shipped. `recurrence_created: false`, no error, checkbox and
    `✅` date set as if it had worked. Ruled out caching (survived a restart),
    ruled out the file (reproduced with a throwaway line in the same file *and*
    with one in a fresh file), ruled out `➕` (harmless alone) and the specific
    rule text or reference date (identical rule+date without `⏰`/`⏱` worked
    fine) — narrowed to exactly those two fields by adding one at a time. Fixed
    in `completeTask()` itself: strip them before dispatching `toggle-done`,
    reinsert into whichever resulting lines are task lines afterward. See the
    `⏰`/`⏱` bullet above.

**Still open**

11. **`complete_task` toggles in place; it does not archive.** The completed
    `[x]` line stays where it was, next to the new occurrence. For tasks in
    `tasks/offen.md` the archiving step is still `tasks.py done ^t-<old-id>`,
    which does find and move an already-toggled line (verified against copies of
    the real files, not the real ones). So the full sequence for a recurring task
    is `complete_task` first, `tasks.py done` second, with the *old* id. Whether
    that two-step belongs in the agent prompts or inside `tasks.py` itself is
    Philipp's call, not this repo's.
12. **`tasks.py`'s `ins_archiv()` drops the line silently** if the `## <yyyy-mm>`
    heading in `tasks/erledigt.md` is not followed by a blank line — it reports
    "erledigt und archiviert" either way. Noticed while testing the step above
    against a fixture; the real file is fine. Belongs in `tasks.py`, noted here
    only so it is not lost.

## Layout

```
src/main.ts      plugin lifecycle, server start/stop
src/server.ts    HTTP listener, token auth, MCP server + tool definitions
src/actions.ts   the two vault operations
src/settings.ts  settings tab
test/            smoke test against a stubbed obsidian module
```

## Licence

MIT.
