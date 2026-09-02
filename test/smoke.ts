/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Smoke test for everything that does not need a real Obsidian: the HTTP front
 * door, the bearer check, the MCP handshake, the tool list, argument validation
 * and line resolution.
 *
 * Run with: npm run test:smoke
 */

import { BridgeHttpServer } from '../src/server';
import { DEFAULT_SETTINGS } from '../src/settings';
import { Editor, MarkdownView, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

const TOKEN = 'smoke-token';
const PORT = 27199;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
    if (cond) {
        console.log(`  ok   ${name}`);
    } else {
        failures++;
        console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
    }
}

const files: Record<string, string> = {
    'Aufgaben/geplant.md': [
        '# Geplant',
        '',
        '- [ ] tDCS-Sitzung 🔁 every day 📅 2026-09-02 ^t-abcd',
        '- [ ] Milch kaufen ^t-beef',
        'kein Task, nur Text ^t-dead',
        '- [ ] Blutdruck messen 🔁 every day 📅 2026-09-02 ^t-cafe',
        '',
    ].join('\n'),
    'Notizen/alt.md': '# Alt\n',
};

const leaf = new WorkspaceLeaf();
const renames: Array<[string, string]> = [];
const createdFolders: string[] = [];

const app: any = {
    vault: {
        getAbstractFileByPath: (p: string) => {
            if (files[p] !== undefined) return new TFile(p);
            if (p === 'Notizen' || p === 'Aufgaben') return new TFolder(p);
            return null;
        },
        read: async (f: TFile) => files[f.path],
        createFolder: async (p: string) => {
            createdFolders.push(p);
        },
    },
    workspace: {
        getLeavesOfType: () => [],
        getLeaf: () => leaf,
        setActiveLeaf: () => {},
    },
    fileManager: {
        renameFile: async (f: TFile, to: string) => {
            renames.push([f.path, to]);
        },
    },
    commands: {
        // Stands in for obsidian-tasks-plugin:toggle-done, including the bits that
        // matter most: a recurring task grows into two lines, the real plugin
        // clears the block link on the new occurrence ("New occurrences cannot
        // have the same block link"), and — per toggleWithRecurrenceInUsersOrder()
        // — which of the two comes first is a Tasks *setting*, not a constant. The
        // "Blutdruck" line exercises the done-first order to prove the anchor logic
        // does not assume a position.
        executeCommandById: (id: string) => {
            if (id !== DEFAULT_SETTINGS.toggleDoneCommandId) return false;
            const editor: Editor = (leaf.view as MarkdownView).editor;
            editor.applyToggle((line) => {
                if (line.includes('🔁')) {
                    const withoutAnchor = line.replace(/\s*\^[\w-]+\s*$/, '');
                    const nextOpen = withoutAnchor.replace('- [ ]', '- [ ]').replace('📅 2026-09-02', '📅 2026-09-03');
                    const done = line.replace('- [ ]', '- [x]') + ' ✅ 2026-09-02';
                    return line.includes('Blutdruck') ? [done, nextOpen] : [nextOpen, done];
                }
                return [line.replace('- [ ]', '- [x]') + ' ✅ 2026-09-02'];
            });
            return true;
        },
    },
};

// The leaf always hands back a fresh editor for whichever file was opened.
const origOpen = leaf.openFile.bind(leaf);
leaf.openFile = async (file: TFile, opts?: unknown) => {
    await origOpen(file, opts);
    (leaf.view as MarkdownView).editor = new Editor(files[file.path].split('\n'));
};

async function rpc(
    body: unknown,
    token: string | null = TOKEN,
    path = '/mcp',
    method = 'POST',
    accept = 'application/json, text/event-stream',
) {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: accept,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* SSE or empty */
    }
    return { status: res.status, json, text };
}

function payload(res: any) {
    return JSON.parse(res.json?.result?.content?.[0]?.text ?? '{}');
}

async function main() {
    const settings = { ...DEFAULT_SETTINGS, host: '127.0.0.1', port: PORT, token: TOKEN };
    const server = new BridgeHttpServer(app, settings);
    await server.start();
    check('server listening', server.listening);

    const health = await rpc(null, null, '/health', 'GET');
    check('GET /health is open', health.status === 200 && health.json?.status === 'ok', health);

    const noAuth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null);
    check('POST /mcp without token → 401', noAuth.status === 401, noAuth);

    const badAuth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong');
    check('POST /mcp with wrong token → 401', badAuth.status === 401, badAuth);

    const notFound = await rpc({}, TOKEN, '/other');
    check('unknown path → 404', notFound.status === 404, notFound);

    const init = await rpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'smoke', version: '0' },
        },
    });
    check('initialize succeeds', init.status === 200 && !!init.json?.result?.serverInfo, init);

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list.json?.result?.tools ?? []).map((t: any) => t.name).sort();
    check('tools/list returns exactly the two tools', JSON.stringify(names) === '["complete_task","rename_file"]', names);

    // Documents what a curl/requests caller must send. The Streamable HTTP spec
    // wants both media types in Accept even when the answer comes back as JSON.
    const plainAccept = await rpc(
        { jsonrpc: '2.0', id: 99, method: 'tools/list' },
        TOKEN,
        '/mcp',
        'POST',
        'application/json',
    );
    console.log(`  note Accept: application/json alone → HTTP ${plainAccept.status}`);

    const rec = await rpc({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', anchor: 't-abcd' } },
    });
    const recBody = payload(rec);
    check('complete_task by anchor succeeds', recBody.ok === true, recBody);
    check('complete_task reports the recurrence line', recBody.recurrence_created === true && recBody.lines_after?.length === 2, recBody);
    check('complete_task reports 1-based line number', recBody.line_number === 3, recBody);
    check('complete_task saved the file', (leaf.view as MarkdownView).saved === true);
    check(
        'a fresh, unused anchor is minted for the new occurrence',
        typeof recBody.anchor_added === 'string' &&
            /^t-[0-9a-f]{4}$/.test(recBody.anchor_added) &&
            !['t-abcd', 't-beef', 't-dead'].includes(recBody.anchor_added),
        recBody,
    );
    check(
        'the new occurrence line carries the minted anchor, the done line keeps the original',
        recBody.lines_after?.[0]?.endsWith(`^${recBody.anchor_added}`) &&
            recBody.lines_after?.[1]?.includes('^t-abcd'),
        recBody,
    );

    const plain = await rpc({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', anchor: '^t-beef' } },
    });
    const plainBody = payload(plain);
    check('anchor accepts a leading ^', plainBody.ok === true, plainBody);
    check('non-recurring task creates nothing', plainBody.recurrence_created === false, plainBody);
    check('no anchor is minted when nothing new was created', plainBody.anchor_added === null, plainBody);

    const recReversed = await rpc({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', anchor: 't-cafe' } },
    });
    const recReversedBody = payload(recReversed);
    check(
        'anchor is minted on the new occurrence even when Tasks puts the done line first',
        typeof recReversedBody.anchor_added === 'string' &&
            recReversedBody.lines_after?.[0]?.includes('^t-cafe') &&
            recReversedBody.lines_after?.[1]?.endsWith(`^${recReversedBody.anchor_added}`),
        recReversedBody,
    );

    const notATask = await rpc({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', anchor: 't-dead' } },
    });
    check('refuses a line that is not a checklist item', notATask.json?.result?.isError === true, notATask.json?.result);

    const missing = await rpc({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', anchor: 't-nope' } },
    });
    check('unknown anchor is an error, not a silent no-op', missing.json?.result?.isError === true, missing.json?.result);

    const noSelector = await rpc({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md' } },
    });
    check('missing selector is an error', noSelector.json?.result?.isError === true, noSelector.json?.result);

    const byNumber = await rpc({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'complete_task', arguments: { path: 'Aufgaben/geplant.md', line_number: 4 } },
    });
    check('complete_task by 1-based line number hits the right line', payload(byNumber).line_before?.includes('Milch'), payload(byNumber));

    const ren = await rpc({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'rename_file', arguments: { from: 'Notizen/alt.md', to: 'Archiv/neu.md' } },
    });
    const renBody = payload(ren);
    check('rename_file calls fileManager.renameFile', renBody.ok === true && renames[0]?.[1] === 'Archiv/neu.md', renBody);
    check('rename_file creates the missing parent folder', createdFolders.includes('Archiv'), createdFolders);

    const renMissing = await rpc({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'rename_file', arguments: { from: 'Notizen/gibtsnicht.md', to: 'x.md' } },
    });
    check('rename_file on a missing source errors', renMissing.json?.result?.isError === true, renMissing.json?.result);

    const renExists = await rpc({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'rename_file', arguments: { from: 'Notizen/alt.md', to: 'Aufgaben/geplant.md' } },
    });
    check('rename_file refuses to overwrite', renExists.json?.result?.isError === true, renExists.json?.result);

    await server.stop();
    check('server stopped', !server.listening);

    console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

void main();
