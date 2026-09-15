/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Fast Note Sync conflict resolver against a fake sync plugin.
 *
 * The fake mirrors only the members src/conflicts.ts touches. What it cannot show
 * is whether the real plugin reacts to the resolve message the way its own dialog
 * does — that is checked live (see README, "Sync conflicts").
 *
 * Run with: npm run test:smoke
 */

import { ConflictResolver, decide, hash32, mergeThreeWay } from '../src/conflicts';

(globalThis as any).window = globalThis;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) console.log(`  ok   ${name}`);
    else {
        failures++;
        console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
    }
}

const PATH = 'tasks/offen.md';
const SYNC_DIR = '.obsidian/plugins/fast-note-sync';
const REMOTE_MD = `${SYNC_DIR}/conflict-notes/tasks_offen_${hash32(PATH)}.remote.md`;
const BASE_MD = `${SYNC_DIR}/conflict-notes/tasks_offen_${hash32(PATH)}.base.md`;

// Shaped like the real incident, with made-up tasks: the frozen copy still has
// three lines that were ticked off elsewhere; meanwhile the server moved on.
const X = [
    '---', 'tags:', '  - tasks', '---', '',
    '- [ ] Routine A ⏳2026-09-14 ^t-0001',
    '- [ ] Wrap machen ⏰14:00 ⏱2h ➕2026-09-14 ⏳2026-09-14 ^t-0002',
    '- [ ] Idee überdenken ^t-0003',
    '- [ ] App-Fehler eins #projekt/x ➕2026-09-14 ^t-0004',
    '- [ ] App-Fehler zwei #projekt/x ➕2026-09-14 ^t-0005',
    '- [ ] Nachfragen #projekt/x ➕2026-09-14 ^t-0006',
    '- [ ] Letzte Aufgabe ^t-0007',
    '',
].join('\n');
const Y = X
    .replace(/^- \[ \] App-Fehler eins.*\n/m, '')
    .replace(/^- \[ \] App-Fehler zwei.*\n/m, '')
    .replace(/^- \[ \] Nachfragen.*\n/m, '')
    .replace('⏰14:00 ⏱2h ➕2026-09-14 ⏳2026-09-14', '⏰14:00 ⏱2h ↩1 ➕2026-09-14 ⏳2026-09-15')
    .replace('- [ ] Letzte Aufgabe ^t-0007\n', '- [ ] Letzte Aufgabe ^t-0007\n- [ ] Neu vom Handy ^t-0008\n');

function env(opts: { local: string; server: string | null; history?: string[]; hooks?: boolean }) {
    let clock = 1_000;
    const files = new Map<string, { text: string; mtime: number }>();
    files.set(PATH, { text: opts.local, mtime: clock });
    const vault = {
        configDir: '.obsidian',
        getFileByPath: (p: string) => (files.has(p) ? { path: p, stat: { mtime: files.get(p)!.mtime, ctime: 1, size: files.get(p)!.text.length } } : null),
        read: async (f: any) => files.get(f.path)!.text,
        modify: async (f: any, t: string) => void files.set(f.path, { text: t, mtime: ++clock }),
        adapter: {
            exists: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/')),
            read: async (p: string) => files.get(p)!.text,
            write: async (p: string, t: string) => void files.set(p, { text: t, mtime: ++clock }),
            append: async (p: string, t: string) => void files.set(p, { text: (files.get(p)?.text ?? '') + t, mtime: ++clock }),
            remove: async (p: string) => void files.delete(p),
            mkdir: async () => {},
            stat: async (p: string) => (files.has(p) ? { mtime: files.get(p)!.mtime } : null),
        },
    };
    const sent: any[] = [];
    const hashes = new Map<string, string>();
    const sync: any = {
        manifest: { dir: SYNC_DIR },
        settings: { vault: 'V' },
        syncState: { conflictedPaths: new Set<string>() },
        persisted: null as string[] | null,
        localStorageManager: {
            setConflictedPaths: (s: Set<string>) => (sync.persisted = [...s]),
            savePending: () => {},
        },
        statusBarManager: { updateConflictBadge: () => {} },
        fileHashManager: {
            getPathHash: (p: string) => hashes.get(p) ?? null,
            setFileHash: (p: string, h: string) => void hashes.set(p, h),
        },
        pendingNoteModifies: new Map<string, string>(),
        websocket: { SendMessage: (action: string, data: any) => void sent.push({ action, data }) },
        api: {
            onFetch: null as null | (() => void),
            request: async () => {
                sync.api.onFetch?.();
                return opts.server === null ? { status: 500, json: {} } : { status: 200, json: { code: 1, data: { content: opts.server, contentHash: hash32(opts.server) } } };
            },
            getNoteHistoryList: async (_p: string, page = 1) => ({
                list: page === 1 ? (opts.history ?? []).map((_, i) => ({ id: i + 1 })) : [],
                totalRows: (opts.history ?? []).length,
            }),
            getNoteHistoryDetail: async (id: number) => ({ content: (opts.history ?? [])[id - 1] }),
        },
        lockManager: { withLock: async (_p: string, fn: () => Promise<any>) => fn() },
        concurrencyLimiter: { waitForSlot: async () => {} },
        ignored: [] as string[],
        addIgnoredFile: (p: string) => sync.ignored.push(p),
        removeIgnoredFile: () => {},
    };
    const app: any = { vault, plugins: { plugins: { 'fast-note-sync': sync } } };
    let enabled = true;
    const resolver = new ConflictResolver(app, '.obsidian/plugins/mcp-bridge', () => enabled);
    if (opts.hooks !== false) resolver.installHooks();
    return {
        files, sync, sent, hashes, resolver, app,
        setEnabled: (v: boolean) => (enabled = v),
        /** What the plugin does when a push arrives for a note with an unsynced edit. */
        skipPush: async (content: string) => {
            await vault.adapter.write(REMOTE_MD, content);
            if (!files.has(BASE_MD)) await vault.adapter.write(BASE_MD, files.get(PATH)!.text);
            sync.syncState.conflictedPaths.add(PATH);
        },
        text: () => files.get(PATH)!.text,
    };
}

async function main() {
    console.log('pure merge');
    check('identical sides', decide('a', 'a', null).outcome === 'identical');
    check('no base: server wins', decide('a', 'b', null).outcome === 'server-wins-no-base' && decide('a', 'b', null).text === 'b');
    check('local unchanged since base: take remote', decide(X, Y, X).outcome === 'take-remote' && decide(X, Y, X).text === Y);
    check('remote unchanged since base: take local', decide(Y, X, X).outcome === 'take-local');
    const m = mergeThreeWay('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nc\nD\n');
    check('different lines: both kept', m.text === 'a\nB\nc\nD\n' && m.conflictHunks === 0, m);
    const c = mergeThreeWay('a\nb\nc\n', 'a\nLOCAL\nc\n', 'a\nSERVER\nc\n');
    check('same line: server wins that hunk', c.text === 'a\nSERVER\nc\n' && c.conflictHunks === 1, c);
    const del = mergeThreeWay(X, X.replace('Idee überdenken', 'Idee neu überdenken'), Y);
    check(
        'deleted lines stay deleted while an edit on the line right above survives',
        !del.text.includes('App-Fehler') && del.text.includes('Idee neu überdenken') && del.text.includes('Neu vom Handy') && del.conflictHunks === 0,
        del,
    );
    const adj = mergeThreeWay('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n');
    check('adjacent lines changed on different sides: both kept', adj.text === 'a\nB\nC\n' && adj.conflictHunks === 0, adj);
    const ins = mergeThreeWay('a\nb\n', 'a\nL\nb\n', 'a\nR\nb\n');
    check('both insert at the same spot: server wins', ins.text === 'a\nR\nb\n' && ins.conflictHunks === 1, ins);
    const twice = mergeThreeWay('a\nb\nc\n', 'a\nB\nc\nd\n', 'a\nB\nc\n');
    check('same change on both sides applied once', twice.text === 'a\nB\nc\nd\n' && twice.conflictHunks === 0, twice);
    const gone = mergeThreeWay('a\nb\nc\n', 'a\nb geändert\nc\n', 'a\nc\n');
    check('edited locally, deleted on the server: server wins (stays deleted)', gone.text === 'a\nc\n' && gone.conflictHunks === 1, gone);
    const inside = mergeThreeWay('a\nb\nc\nd\n', 'a\nb\nX\nc\nd\n', 'a\nB\nC\nd\n');
    check('insert inside a stretch the server replaced: server wins', inside.text === 'a\nB\nC\nd\n' && inside.conflictHunks === 1, inside);
    {
        // Random edits: one side alone always comes through unchanged, and merging a
        // side with itself is that side.
        let seed = 7;
        const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
        const mutate = (lines: string[]) => {
            const l = [...lines];
            for (let k = rnd(4); k >= 0; k--) {
                const i = rnd(l.length + 1);
                const op = rnd(3);
                if (op === 0) l.splice(i, 0, `neu${rnd(1000)}`);
                else if (op === 1 && l.length) l.splice(Math.min(i, l.length - 1), 1);
                else if (l.length) l[Math.min(i, l.length - 1)] += ' geändert';
            }
            return l;
        };
        let bad: unknown = null;
        for (let t = 0; t < 500 && !bad; t++) {
            const b = Array.from({ length: 3 + rnd(12) }, (_, i) => `zeile ${i}`);
            const side = mutate(b).join('\n');
            const bs = b.join('\n');
            if (mergeThreeWay(bs, side, bs).text !== side) bad = { b, side, as: 'local' };
            if (mergeThreeWay(bs, bs, side).text !== side) bad = { b, side, as: 'remote' };
            const other = mutate(b).join('\n');
            if (mergeThreeWay(bs, other, other).text !== other) bad = { b, other, as: 'both' };
        }
        check('random edits: one-sided and identical changes come through exactly', bad === null, bad);
    }

    console.log('the 2026-09-15 incident');
    {
        const e = env({ local: X, server: Y });
        e.sync.fileHashManager.setFileHash(PATH, hash32(X)); // last in sync: X (hook files the base)
        await new Promise((r) => setTimeout(r, 5));
        check('hook filed the base snapshot', [...e.files.keys()].some((k) => k.startsWith('.obsidian/plugins/mcp-bridge/sync-base/')));
        await e.skipPush(Y);
        const [r] = await e.resolver.tick();
        check('frozen copy takes the server version', r?.outcome === 'take-remote' && e.text() === Y, r);
        check('the three ticked-off lines do not come back', !e.text().includes('App-Fehler') && !e.text().includes('Nachfragen'));
        check('conflict flag cleared and persisted', !e.sync.syncState.conflictedPaths.has(PATH) && JSON.stringify(e.sync.persisted) === '[]');
        check('conflict-notes cleaned up', !e.files.has(REMOTE_MD) && !e.files.has(BASE_MD));
        check('nothing sent: the note already equals the server', e.sent.length === 0, e.sent);
        check('recorded as in sync with the server hash', e.hashes.get(PATH) === hash32(Y));
        check('own write kept away from the plugin\'s modify handler', e.sync.ignored.includes(PATH));
        check('log line written', (e.files.get('.obsidian/plugins/mcp-bridge/sync-conflicts.log')?.text ?? '').includes('"take-remote"'));
    }

    console.log('real merge, base from the snapshot store');
    {
        const e = env({ local: X, server: Y });
        // Local upload of X acknowledged: send + ack, the way the plugin does it.
        e.sync.websocket.SendMessage('NoteModify', { path: PATH, content: X, contentHash: hash32(X) });
        e.sync.fileHashManager.setFileHash(PATH, hash32(X));
        await new Promise((r) => setTimeout(r, 5));
        e.sent.length = 0;
        // Then an agent edits locally, and before the upload is acked the server's Y arrives.
        const local = X.replace('Idee überdenken', 'Idee neu überdenken');
        e.files.set(PATH, { text: local, mtime: 50 });
        e.sync.pendingNoteModifies.set(PATH, hash32(local));
        await e.skipPush(Y);
        const [r] = await e.resolver.tick();
        check('merged with the stored base', r?.outcome === 'merged' && r?.baseSource === 'store', r);
        check('local edit kept, server deletions and additions applied',
            e.text().includes('Idee neu überdenken') && !e.text().includes('App-Fehler') && e.text().includes('Neu vom Handy'), e.text());
        const msg = e.sent.find((s) => s.action === 'NoteModify')?.data;
        check('sent like the resolve button', msg?.isConflictResolved === true && msg?.content === e.text() && msg?.baseHash === hash32(Y), msg);
        check('pending set so the ack commits the new base', e.sync.pendingNoteModifies.get(PATH) === hash32(e.text()));
    }

    console.log('base from the server history');
    {
        const e = env({ local: X.replace('Letzte Aufgabe', 'Letzte Aufgabe, geändert'), server: Y, history: ['anderes', X] });
        e.hashes.set(PATH, hash32(X)); // plugin knows the hash, we never saw the text
        await e.skipPush(Y);
        const [r] = await e.resolver.tick();
        check('history version with the base hash is used', r?.outcome === 'merged' && r?.baseSource === 'history', r);
        check('merge result has both sides', e.text().includes('Letzte Aufgabe, geändert') && e.text().includes('Neu vom Handy'), e.text());
    }

    console.log('fallbacks and refusals');
    {
        const e = env({ local: 'lokal\n', server: 'server\n' });
        await e.skipPush('server\n');
        const [r] = await e.resolver.tick();
        check('no base anywhere: whole file from the server', r?.outcome === 'server-wins-no-base' && e.text() === 'server\n', r);
    }
    {
        const e = env({ local: 'inhalt\n', server: '' });
        e.sync.syncState.conflictedPaths.add(PATH);
        const [r] = await e.resolver.tick();
        check('never writes an empty note over content', r?.outcome === 'refused' && e.text() === 'inhalt\n' && e.sync.syncState.conflictedPaths.has(PATH), r);
    }
    {
        const e = env({ local: X, server: null });
        e.sync.syncState.conflictedPaths.add(PATH); // e.g. right after a restart: conflict-notes were cleared
        const [r] = await e.resolver.tick();
        check('server unreachable and no remote copy: retry later, flag stays', r?.outcome === 'retry' && e.sync.syncState.conflictedPaths.has(PATH), r);
    }
    {
        const e = env({ local: X, server: null });
        await e.skipPush(Y);
        const [r] = await e.resolver.tick();
        check('server unreachable: the last skipped push is used', r?.outcome === 'server-wins-no-base' && e.text() === Y, r);
    }
    {
        const e = env({ local: X, server: Y });
        e.hashes.set(PATH, hash32(X));
        await e.skipPush(Y);
        e.sync.api.onFetch = () => {
            // a newer push lands while we are fetching
            e.files.set(REMOTE_MD, { text: Y + 'noch neuer\n', mtime: Date.now() + 60_000 });
        };
        const [r] = await e.resolver.tick();
        check('newer push during resolution: retry, nothing written', r?.outcome === 'retry' && e.text() === X, r);
    }

    console.log('switches and compatibility');
    {
        const e = env({ local: X, server: Y });
        await e.skipPush(Y);
        e.setEnabled(false);
        check('disabled: the timer does nothing', (await e.resolver.tick()).length === 0 && e.text() === X);
        const forced = await e.resolver.tick(true);
        check('tool call (force) still resolves', forced[0]?.outcome === 'server-wins-no-base' || forced[0]?.outcome === 'take-remote', forced);
    }
    {
        const e = env({ local: X, server: Y, hooks: false });
        delete e.sync.pendingNoteModifies;
        await e.skipPush(Y);
        const res = await e.resolver.tick();
        const st = e.resolver.status();
        check('changed internals: stops and says what is missing', res.length === 0 && st.syncPlugin === 'incompatible' && st.missing.includes('pendingNoteModifies') && e.text() === X, st);
    }
    {
        const e = env({ local: X, server: Y });
        delete e.app.plugins.plugins['fast-note-sync'];
        check('no sync plugin: harmless', (await e.resolver.tick()).length === 0 && e.resolver.status().syncPlugin === 'missing');
    }
    {
        const e = env({ local: X, server: Y });
        e.resolver.installHooks();
        e.resolver.installHooks();
        e.sync.websocket.SendMessage('NoteModify', { path: PATH, content: X, contentHash: hash32(X) });
        check('hooks install once, messages still go through', e.sent.length === 1, e.sent);
    }

    console.log(failures === 0 ? '\nall conflict checks passed' : `\n${failures} conflict check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

void main();
