/**
 * Automatic conflict resolution for the Fast Note Sync plugin on headless instances.
 *
 * Why this exists: Fast Note Sync (plugin 2.4.0, server 3.6.1) puts a note into
 * `syncState.conflictedPaths` when a server push arrives while the note has an
 * unsynced local edit. From then on every push for that note is skipped (the
 * content lands in `conflict-notes/*.remote.md`) until someone clicks through the
 * conflict dialog — which, on an Obsidian running under Xvfb, nobody ever does.
 * The flag is persisted, so the note stays frozen across restarts, and at the next
 * sync round the plugin sends the frozen copy up, where the server (strategy "")
 * writes it without comparison. On 2026-09-15 that brought three tasks that had
 * been ticked off on another device back into tasks/offen.md: the copy on spathi had
 * been frozen for six hours and was pushed at the midnight restart.
 *
 * What this does instead: every tick it looks at the conflicted paths and resolves
 * each one with a three-way merge — base = the version this client last had in
 * sync, local = the file on disk, remote = the server's current version. Hunks only
 * one side touched are taken from that side; hunks both sides touched go to the
 * server. Without a base the whole file goes to the server. The result is written
 * and sent exactly the way the plugin's own "resolve" button does it.
 *
 * Where the base comes from: the plugin only remembers the *hash* of the last
 * synced version (`fileHashManager.getPathHash`). So we keep the text ourselves —
 * every call to `fileHashManager.setFileHash` (the plugin's "this is now in sync",
 * after a received push and after an upload ack) snapshots the matching content
 * into `<this plugin>/sync-base/`. If that snapshot is missing, the server's note
 * history is searched for a version with the same hash.
 *
 * This reaches into another plugin's internals. Everything we touch is checked on
 * every tick; if something is missing the resolver stops and says so in `status`
 * instead of guessing.
 */

import type { App, TFile } from 'obsidian';
import { diffIndices } from 'node-diff3';

export const SYNC_PLUGIN_ID = 'fast-note-sync';

/** The subset of Fast Note Sync we use. Names are the plugin's own (not minified). */
interface FastSync {
    manifest?: { dir?: string; version?: string };
    settings: { vault: string; syncEnabled?: boolean };
    syncState: { conflictedPaths: Set<string> };
    localStorageManager: {
        setConflictedPaths(paths: Set<string>): void;
        savePending(key: string, map: Map<string, string>): void;
    };
    statusBarManager?: { updateConflictBadge(): void };
    fileHashManager: {
        getPathHash(path: string): string | null;
        setFileHash(path: string, hash: string, mtime?: number, size?: number): void;
    };
    pendingNoteModifies: Map<string, string>;
    websocket: { SendMessage(action: string, data: unknown, ...rest: unknown[]): unknown };
    api: {
        request(endpoint: string, options: { method: string }): Promise<{ status: number; json: unknown }>;
        getNoteHistoryList(path: string, page?: number, pageSize?: number): Promise<{ list: { id: number }[]; totalRows: number }>;
        getNoteHistoryDetail(id: number): Promise<{ content: string }>;
    };
    lockManager?: { withLock<T>(path: string, fn: () => Promise<T>, opts?: { maxRetries?: number; retryInterval?: number }): Promise<T | null> };
    concurrencyLimiter?: { waitForSlot(path: string): Promise<void> };
    addIgnoredFile?(path: string): void;
    removeIgnoredFile?(path: string): void;
}

/** Same 32-bit string hash as the plugin and the server (UTF-16 code units). */
export function hash32(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h << 5) - h + s.charCodeAt(i);
        h |= 0;
    }
    return String(h);
}

export type Outcome =
    | 'identical'
    | 'take-remote'
    | 'take-local'
    | 'merged'
    | 'server-wins-no-base'
    | 'cleared-missing-file'
    | 'retry'
    | 'refused';

export interface Resolution {
    path: string;
    outcome: Outcome;
    baseSource?: 'store' | 'history' | 'local' | 'remote' | null;
    /** Hunks both sides changed; the server's side was taken for each. */
    conflictHunks?: number;
    detail?: string;
}

interface Hunk {
    side: 'local' | 'remote';
    /** Base range [s, e) this hunk replaces; s === e is a pure insertion before base line s. */
    s: number;
    e: number;
    lines: string[];
}

function hunks(base: string[], side: string[], name: Hunk['side']): Hunk[] {
    return diffIndices(base, side).map((d) => ({
        side: name,
        s: d.buffer1[0],
        e: d.buffer1[0] + d.buffer1[1],
        lines: d.buffer2Content,
    }));
}

function same(x: Hunk, y: Hunk): boolean {
    return x.s === y.s && x.e === y.e && x.lines.join('\n') === y.lines.join('\n');
}

/**
 * Do two hunks from different sides fight over the same base lines? Only then is
 * it a conflict. Classic diff3 also flags *adjacent* changes, which in a task list
 * is the normal case (an agent edits one line, the phone ticks off the next) and
 * would hand every such pair to the server.
 */
function clash(x: Hunk, y: Hunk): boolean {
    if (same(x, y)) return false;
    const xIns = x.s === x.e;
    const yIns = y.s === y.e;
    if (xIns && yIns) return x.s === y.s;
    if (xIns) return y.s < x.s && x.s < y.e;
    if (yIns) return x.s < y.s && y.s < x.e;
    return x.s < y.e && y.s < x.e;
}

/**
 * Line-based three-way merge. Changes only one side made are applied; where both
 * sides changed the same base lines (or inserted at the same spot), the server's
 * version of that stretch wins and the local one is dropped.
 */
export function mergeThreeWay(base: string, local: string, remote: string): { text: string; conflictHunks: number } {
    const o = base.split('\n');
    const all = [...hunks(o, local.split('\n'), 'local'), ...hunks(o, remote.split('\n'), 'remote')];

    // Group hunks that clash (transitively); a group with both sides is one conflict.
    const group = all.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            if (all[i].side !== all[j].side && clash(all[i], all[j])) group[find(i)] = find(j);
        }
    }
    const sides = new Map<number, Set<string>>();
    all.forEach((h, i) => (sides.get(find(i)) ?? sides.set(find(i), new Set()).get(find(i))!).add(h.side));
    const conflictGroups = new Set([...sides].filter(([, v]) => v.size > 1).map(([k]) => k));

    const keep = all.filter((h, i) => {
        if (conflictGroups.has(find(i)) && h.side === 'local') return false;
        // The same change on both sides: apply it once.
        if (h.side === 'remote') return true;
        return !all.some((r) => r.side === 'remote' && same(r, h));
    });
    // Insertions before a replacement that starts at the same base line.
    keep.sort((x, y) => x.s - y.s || (x.s === x.e ? 0 : 1) - (y.s === y.e ? 0 : 1));

    const out: string[] = [];
    let pos = 0;
    for (const h of keep) {
        out.push(...o.slice(pos, h.s), ...h.lines);
        pos = h.e;
    }
    out.push(...o.slice(pos));
    return { text: out.join('\n'), conflictHunks: conflictGroups.size };
}

/**
 * Pure decision: what should the note become? Kept separate from the I/O so the
 * cases can be tested without a sync plugin.
 */
export function decide(
    local: string,
    remote: string,
    base: string | null,
): { outcome: Exclude<Outcome, 'cleared-missing-file' | 'retry' | 'refused'>; text: string; conflictHunks: number } {
    if (local === remote) return { outcome: 'identical', text: local, conflictHunks: 0 };
    if (base === null) return { outcome: 'server-wins-no-base', text: remote, conflictHunks: 0 };
    if (local === base) return { outcome: 'take-remote', text: remote, conflictHunks: 0 };
    if (remote === base) return { outcome: 'take-local', text: local, conflictHunks: 0 };
    const m = mergeThreeWay(base, local, remote);
    return { outcome: 'merged', text: m.text, conflictHunks: m.conflictHunks };
}

const REQUIRED: [string, (s: any) => boolean][] = [
    ['syncState.conflictedPaths', (s) => s?.syncState?.conflictedPaths instanceof Set],
    ['localStorageManager.setConflictedPaths', (s) => typeof s?.localStorageManager?.setConflictedPaths === 'function'],
    ['localStorageManager.savePending', (s) => typeof s?.localStorageManager?.savePending === 'function'],
    ['fileHashManager.getPathHash', (s) => typeof s?.fileHashManager?.getPathHash === 'function'],
    ['fileHashManager.setFileHash', (s) => typeof s?.fileHashManager?.setFileHash === 'function'],
    ['pendingNoteModifies', (s) => s?.pendingNoteModifies instanceof Map],
    ['websocket.SendMessage', (s) => typeof s?.websocket?.SendMessage === 'function'],
    ['api.request', (s) => typeof s?.api?.request === 'function'],
    ['api.getNoteHistoryList', (s) => typeof s?.api?.getNoteHistoryList === 'function'],
    ['api.getNoteHistoryDetail', (s) => typeof s?.api?.getNoteHistoryDetail === 'function'],
    ['settings.vault', (s) => typeof s?.settings?.vault === 'string'],
];

const WRAPPED = Symbol.for('obsidian-mcp-bridge.wrapped');
const MAX_HISTORY_LOOKUPS = 100;

export interface ResolverStatus {
    enabled: boolean;
    syncPlugin: 'missing' | 'incompatible' | 'ok';
    missing: string[];
    conflicted: string[];
    lastTick: string | null;
    recent: (Resolution & { ts: string })[];
}

export class ConflictResolver {
    private readonly baseDir: string;
    private readonly logPath: string;
    /** Content of outgoing NoteModify messages, so an ack can file the exact text as base. */
    private readonly outgoing = new Map<string, string>();
    private running = false;
    private missing: string[] = [];
    private syncPluginState: ResolverStatus['syncPlugin'] = 'missing';
    private lastTick: string | null = null;
    private recent: (Resolution & { ts: string })[] = [];

    constructor(
        private readonly app: App,
        /** Vault-relative directory of this plugin, e.g. ".obsidian/plugins/mcp-bridge". */
        pluginDir: string,
        private readonly isEnabled: () => boolean,
    ) {
        this.baseDir = `${pluginDir}/sync-base`;
        this.logPath = `${pluginDir}/sync-conflicts.log`;
    }

    private sync(): FastSync | null {
        const plugins = (this.app as any).plugins?.plugins as Record<string, unknown> | undefined;
        const s = plugins?.[SYNC_PLUGIN_ID] as any;
        if (!s) {
            this.syncPluginState = 'missing';
            this.missing = [];
            return null;
        }
        const missing = REQUIRED.filter(([, ok]) => !ok(s)).map(([name]) => name);
        if (missing.length) {
            if (this.syncPluginState !== 'incompatible' || missing.join() !== this.missing.join()) {
                console.error(`[obsidian-mcp-bridge] fast-note-sync internals changed, resolver stopped: ${missing.join(', ')}`);
            }
            this.syncPluginState = 'incompatible';
            this.missing = missing;
            return null;
        }
        this.syncPluginState = 'ok';
        this.missing = [];
        return s as FastSync;
    }

    status(): ResolverStatus {
        const s = this.sync();
        return {
            enabled: this.isEnabled(),
            syncPlugin: this.syncPluginState,
            missing: this.missing,
            conflicted: s ? [...s.syncState.conflictedPaths] : [],
            lastTick: this.lastTick,
            recent: this.recent.slice(-20),
        };
    }

    /**
     * Hook the plugin so every "now in sync" also files the text as base. Idempotent;
     * called every tick because the plugin may rebuild its websocket on reconnect.
     */
    installHooks(): void {
        const s = this.sync();
        if (!s) return;
        const ws = s.websocket as any;
        if (!ws[WRAPPED]) {
            const orig = ws.SendMessage;
            ws.SendMessage = (action: string, data: any, ...rest: unknown[]) => {
                try {
                    if (action === 'NoteModify' && typeof data?.path === 'string' && typeof data?.content === 'string' && data.path.endsWith('.md')) {
                        const hash = typeof data.contentHash === 'string' ? data.contentHash : hash32(data.content);
                        this.outgoing.set(`${data.path}\n${hash}`, data.content);
                        if (this.outgoing.size > 500) this.outgoing.delete(this.outgoing.keys().next().value as string);
                    }
                } catch (e) {
                    console.error('[obsidian-mcp-bridge] base capture (send) failed', e);
                }
                return orig.call(ws, action, data, ...rest);
            };
            ws[WRAPPED] = true;
        }
        const fhm = s.fileHashManager as any;
        if (!fhm[WRAPPED]) {
            const orig = fhm.setFileHash;
            fhm.setFileHash = (path: string, hash: string, ...rest: unknown[]) => {
                const r = orig.call(fhm, path, hash, ...rest);
                if (typeof path === 'string' && path.endsWith('.md') && typeof hash === 'string' && hash) {
                    void this.captureBase(path, hash);
                }
                return r;
            };
            fhm[WRAPPED] = true;
        }
    }

    private baseFile(path: string): string {
        return `${this.baseDir}/${hash32(path).replace('-', 'm')}.json`;
    }

    private async captureBase(path: string, hash: string): Promise<void> {
        try {
            const key = `${path}\n${hash}`;
            let content = this.outgoing.get(key);
            if (content !== undefined) this.outgoing.delete(key);
            else {
                // A received push: the plugin wrote it to disk right before calling us.
                const f = this.app.vault.getFileByPath(path);
                if (!f) return;
                const disk = await this.app.vault.read(f);
                if (hash32(disk) !== hash) return; // already changed again — no base this time
                content = disk;
            }
            const a = this.app.vault.adapter;
            if (!(await a.exists(this.baseDir))) await a.mkdir(this.baseDir);
            await a.write(this.baseFile(path), JSON.stringify({ path, hash, content }));
        } catch (e) {
            console.error(`[obsidian-mcp-bridge] base capture failed for ${path}`, e);
        }
    }

    private async storedBase(path: string, hash: string): Promise<string | null> {
        const a = this.app.vault.adapter;
        const f = this.baseFile(path);
        if (!(await a.exists(f))) return null;
        try {
            const j = JSON.parse(await a.read(f));
            return j.path === path && j.hash === hash && typeof j.content === 'string' ? j.content : null;
        } catch {
            return null;
        }
    }

    private async historyBase(s: FastSync, path: string, hash: string): Promise<string | null> {
        let seen = 0;
        for (let page = 1; seen < MAX_HISTORY_LOOKUPS; page++) {
            const { list } = await s.api.getNoteHistoryList(path, page, 20);
            if (!list.length) return null;
            for (const item of list) {
                if (++seen > MAX_HISTORY_LOOKUPS) return null;
                // A history record holds the text *before* that version.
                const d = await s.api.getNoteHistoryDetail(item.id);
                if (typeof d?.content === 'string' && hash32(d.content) === hash) return d.content;
            }
        }
        return null;
    }

    private async serverNote(s: FastSync, path: string): Promise<{ content: string; hash: string } | null> {
        const q = new URLSearchParams({ vault: s.settings.vault, path, pathHash: hash32(path) });
        const { status, json } = await s.api.request(`/api/note?${q}`, { method: 'GET' });
        const data = (json as any)?.data;
        if (status !== 200 || typeof data?.content !== 'string') return null;
        return { content: data.content, hash: typeof data.contentHash === 'string' ? data.contentHash : hash32(data.content) };
    }

    private conflictNotes(s: FastSync, path: string): { base: string; remote: string; dir: string } {
        const dir = `${s.manifest?.dir || `${this.app.vault.configDir}/plugins/${SYNC_PLUGIN_ID}`}/conflict-notes`;
        const safe = path.replace(/\.md$/, '').replace(/[/\\]/g, '_');
        const ph = hash32(path);
        return { dir, base: `${dir}/${safe}_${ph}.base.md`, remote: `${dir}/${safe}_${ph}.remote.md` };
    }

    /** One pass over all conflicted notes. Safe to call concurrently — the second call is a no-op. */
    async tick(force = false): Promise<Resolution[]> {
        if (this.running) return [];
        if (!force && !this.isEnabled()) return [];
        this.running = true;
        try {
            this.lastTick = new Date().toISOString();
            const s = this.sync();
            if (!s) return [];
            this.installHooks();
            const out: Resolution[] = [];
            for (const path of [...s.syncState.conflictedPaths]) {
                let r: Resolution;
                try {
                    r = await this.resolveOne(s, path);
                } catch (e) {
                    r = { path, outcome: 'retry', detail: e instanceof Error ? e.message : String(e) };
                }
                out.push(r);
                await this.record(r);
            }
            return out;
        } finally {
            this.running = false;
        }
    }

    private async record(r: Resolution): Promise<void> {
        const entry = { ts: new Date().toISOString(), ...r };
        this.recent.push(entry);
        if (this.recent.length > 100) this.recent.shift();
        try {
            const a = this.app.vault.adapter;
            const line = JSON.stringify(entry) + '\n';
            if (await a.exists(this.logPath)) await a.append(this.logPath, line);
            else await a.write(this.logPath, line);
        } catch (e) {
            console.error('[obsidian-mcp-bridge] could not write sync-conflicts.log', e);
        }
        console.log(`[obsidian-mcp-bridge] sync conflict ${r.path}: ${r.outcome}${r.detail ? ` (${r.detail})` : ''}`);
    }

    private clearFlag(s: FastSync, path: string): void {
        s.syncState.conflictedPaths.delete(path);
        s.localStorageManager.setConflictedPaths(s.syncState.conflictedPaths);
        s.statusBarManager?.updateConflictBadge();
    }

    private async resolveOne(s: FastSync, path: string): Promise<Resolution> {
        const a = this.app.vault.adapter;
        const cn = this.conflictNotes(s, path);
        const file = this.app.vault.getFileByPath(path);
        if (!file) {
            this.clearFlag(s, path);
            return { path, outcome: 'cleared-missing-file' };
        }

        // Remote: the server's current version; the last skipped push as fallback.
        const fetchedAt = Date.now();
        let remote: string | null = null;
        try {
            remote = (await this.serverNote(s, path))?.content ?? null;
        } catch {
            remote = null;
        }
        if (remote === null && (await a.exists(cn.remote))) remote = await a.read(cn.remote);
        if (remote === null) return { path, outcome: 'retry', detail: 'no server version reachable' };

        // Base: the last version this client had in sync.
        const local0 = await this.app.vault.read(file);
        const baseHash = s.fileHashManager.getPathHash(path);
        let base: string | null = null;
        let baseSource: Resolution['baseSource'] = null;
        if (baseHash) {
            if (hash32(local0) === baseHash) [base, baseSource] = [local0, 'local'];
            else if (hash32(remote) === baseHash) [base, baseSource] = [remote, 'remote'];
            else if ((base = await this.storedBase(path, baseHash)) !== null) baseSource = 'store';
            else {
                try {
                    base = await this.historyBase(s, path, baseHash);
                } catch {
                    base = null;
                }
                if (base !== null) baseSource = 'history';
            }
        }

        const d = decide(local0, remote, base);
        if (d.text === '' && (local0 !== '' || remote !== '')) {
            return { path, outcome: 'refused', baseSource, detail: 'result would be empty' };
        }

        type Applied = { r: Resolution; msg?: Record<string, unknown> };
        const apply = async (): Promise<Applied> => {
            // Anything newer than what we merged from? Then try again next tick.
            const local = await this.app.vault.read(file);
            if (local !== local0) return { r: { path, outcome: 'retry', detail: 'local file changed during resolution' } };
            if (await a.exists(cn.remote)) {
                const st = await a.stat(cn.remote);
                if (st && st.mtime > fetchedAt) return { r: { path, outcome: 'retry', detail: 'newer server push arrived' } };
            }

            const text = d.text;
            const hash = hash32(text);
            if (text !== local) {
                // Keep the plugin's own modify handler out of it; we send below.
                s.addIgnoredFile?.(path);
                try {
                    await this.app.vault.modify(file as TFile, text);
                } finally {
                    window.setTimeout(() => s.removeIgnoredFile?.(path), 500);
                }
            }
            this.clearFlag(s, path);
            for (const f of [cn.base, cn.remote]) if (await a.exists(f)) await a.remove(f);

            const r: Resolution = { path, outcome: d.outcome, baseSource, conflictHunks: d.conflictHunks || undefined };
            const f2 = this.app.vault.getFileByPath(path) as TFile | null;
            if (text === remote) {
                // Already what the server has: just record it as in sync.
                s.fileHashManager.setFileHash(path, hash, f2?.stat.mtime ?? 0, f2?.stat.size ?? 0);
                return { r };
            }
            // Same message the plugin's resolve button sends; the ack commits the hash.
            s.pendingNoteModifies.set(path, hash);
            s.localStorageManager.savePending('pendingNoteModifies', s.pendingNoteModifies);
            return {
                r,
                msg: {
                    vault: s.settings.vault,
                    path,
                    pathHash: hash32(path),
                    baseHash: hash32(remote as string),
                    content: text,
                    contentHash: hash,
                    ctime: f2?.stat.ctime ?? 0,
                    mtime: f2?.stat.mtime ?? Date.now(),
                    isConflictResolved: true,
                },
            };
        };

        // Take the plugin's per-path lock so a push can't land between check and write.
        // Sending happens outside it: waiting for an upload slot can take a while, and a
        // push arriving meanwhile just re-flags the note for the next tick.
        let applied: Applied | null;
        if (s.lockManager) applied = await s.lockManager.withLock(path, apply, { maxRetries: 20, retryInterval: 50 });
        else applied = await apply();
        if (!applied) return { path, outcome: 'retry', detail: 'path lock busy' };
        if (applied.msg) {
            await s.concurrencyLimiter?.waitForSlot(path);
            void s.websocket.SendMessage('NoteModify', applied.msg);
        }
        return applied.r;
    }
}
