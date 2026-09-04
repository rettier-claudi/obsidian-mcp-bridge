/**
 * HTTP front door for the bridge.
 *
 * Transport is Streamable HTTP, not stdio, because the callers live somewhere
 * else: tasks.py runs in another container, n8n on another host again. A stdio
 * server would only serve whoever could fork the process, which is nobody here.
 *
 * Stateless mode (no session id) with `enableJsonResponse`, so a caller can be a
 * five-line `requests.post(...)` and does not have to hold an SSE stream open or
 * juggle Mcp-Session-Id headers. Each request gets its own Server + transport
 * pair, which is the SDK's recommended shape for stateless serving and avoids
 * request-id collisions between concurrent callers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { createServer } from 'http';
import { timingSafeEqual } from 'crypto';
// Explicit import rather than the global: Obsidian's renderer has one, but not
// every Electron build exposes it, and this file must not depend on that.
import { Buffer } from 'buffer';
import type { App } from 'obsidian';
import { ActionError, completeTask, renameFile } from './actions';
import type { McpBridgeSettings } from './settings';

const SERVER_NAME = 'obsidian-mcp-bridge';
const SERVER_VERSION = '0.1.1';
// Node lower-cases incoming header names.
const TOKEN_HEADER = 'x-bridge-token';

const TOOLS = [
    {
        name: 'complete_task',
        description:
            'Tick off a Tasks-plugin checklist item in the vault by running Obsidian\'s own ' +
            '"Toggle task done" command on it. Sets [x] and the ✅ done date, and — for a ' +
            'recurring task (🔁) — inserts the next open occurrence, which no external ' +
            'regex edit can do. Tasks strips the block anchor from that new occurrence; this ' +
            'tool mints and appends a fresh ^t-xxxx id in tasks.py\'s own format so the new ' +
            'line stays addressable (see anchor_added in the result). It also strips any ⏰ ' +
            '(time) / ⏱ (duration) field before toggling and puts it back on both resulting ' +
            'lines afterward — their mere presence otherwise makes Tasks silently skip ' +
            'creating the recurrence (see custom_fields_preserved in the result). Identify ' +
            'the line by block anchor (preferred), unique text, or line number.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Vault-relative path of the note, e.g. "Aufgaben/geplant.md".',
                },
                anchor: {
                    type: 'string',
                    description:
                        'Block anchor at the end of the task line, with or without "^", e.g. "t-4f2a". ' +
                        'Preferred: it survives the line moving. Must be unique in the file.',
                },
                line_text: {
                    type: 'string',
                    description: 'Substring that uniquely identifies the task line. Used if no anchor is given.',
                },
                line_number: {
                    type: 'number',
                    description: '1-based line number. Last resort — a stale number ticks off the wrong task.',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'rename_file',
        description:
            'Rename or move a file (or folder) inside the vault using Obsidian\'s own ' +
            'link-aware rename, which rewrites every [[wikilink]] and embed pointing at it. ' +
            'Missing parent folders are created.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'string', description: 'Current vault-relative path, including extension.' },
                to: { type: 'string', description: 'New vault-relative path, including extension.' },
            },
            required: ['from', 'to'],
        },
    },
];

function buildMcpServer(app: App, settings: McpBridgeSettings): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            capabilities: { tools: {} },
            instructions:
                'These tools act on a live Obsidian vault through the running app, so plugin logic ' +
                '(task recurrence, link updating) applies. They change files on disk immediately.',
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        try {
            switch (request.params.name) {
                case 'complete_task': {
                    if (typeof args.path !== 'string' || !args.path) {
                        throw new ActionError('path is required');
                    }
                    const result = await completeTask(app, settings.toggleDoneCommandId, {
                        path: args.path,
                        anchor: typeof args.anchor === 'string' ? args.anchor : undefined,
                        line_text: typeof args.line_text === 'string' ? args.line_text : undefined,
                        line_number: typeof args.line_number === 'number' ? args.line_number : undefined,
                    });
                    return ok(result);
                }
                case 'rename_file': {
                    if (typeof args.from !== 'string' || typeof args.to !== 'string' || !args.from || !args.to) {
                        throw new ActionError('from and to are required');
                    }
                    const result = await renameFile(app, args.from, args.to);
                    return ok(result);
                }
                default:
                    throw new ActionError(`Unknown tool: ${request.params.name}`);
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (!(e instanceof ActionError)) {
                console.error(`[${SERVER_NAME}] ${request.params.name} failed`, e);
            }
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
            };
        }
    });

    return server;
}

function ok(result: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...(result as object) }, null, 2) }] };
}

function tokenMatches(expected: string, presented: string | string[] | undefined): boolean {
    if (typeof presented !== 'string' || !presented) return false;
    const a = Buffer.from(presented.trim());
    const b = Buffer.from(expected);
    // Length differences leak through the early return, which tells an attacker
    // the token length and nothing else; that is the standard trade-off here.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 1_000_000) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

export class BridgeHttpServer {
    private http: HttpServer | null = null;

    constructor(
        private readonly app: App,
        private readonly settings: McpBridgeSettings,
    ) {}

    get listening(): boolean {
        return this.http !== null && this.http.listening;
    }

    async start(): Promise<void> {
        if (this.http) await this.stop();
        if (!this.settings.token) {
            throw new Error('No token set — refusing to expose the vault unauthenticated.');
        }

        const http = createServer((req, res) => {
            this.handle(req, res).catch((e) => {
                console.error(`[${SERVER_NAME}] request failed`, e);
                if (!res.headersSent) sendJson(res, 500, { error: String(e) });
                else res.end();
            });
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (e: Error) => reject(e);
            http.once('error', onError);
            http.listen(this.settings.port, this.settings.host, () => {
                http.off('error', onError);
                resolve();
            });
        });

        this.http = http;
    }

    async stop(): Promise<void> {
        const http = this.http;
        this.http = null;
        if (!http) return;
        await new Promise<void>((resolve) => http.close(() => resolve()));
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = req.url ?? '/';
        const path = url.split('?')[0];

        // Unauthenticated liveness probe. Says nothing about the vault.
        if (path === '/health' && req.method === 'GET') {
            sendJson(res, 200, { status: 'ok', server: SERVER_NAME, version: SERVER_VERSION });
            return;
        }

        if (path !== '/mcp') {
            sendJson(res, 404, { error: 'Not found. The MCP endpoint is POST /mcp.' });
            return;
        }

        // A plain shared-secret header, deliberately not `Authorization: Bearer` +
        // `WWW-Authenticate`. That pair is the specific signal the MCP
        // authorization spec uses to tell a compliant client "do OAuth discovery
        // here" — which this server does not implement, does not want to answer
        // for, and does not want a client attempting over the network for a
        // vault-local tool. A private, static pre-shared token needs none of that
        // machinery.
        if (!tokenMatches(this.settings.token, req.headers[TOKEN_HEADER])) {
            sendJson(res, 401, { error: `Missing or invalid token (expected header: ${TOKEN_HEADER})` });
            return;
        }

        if (req.method !== 'POST') {
            // No standalone SSE stream and no session teardown: this server never
            // pushes anything on its own, so GET and DELETE have nothing to do.
            res.setHeader('Allow', 'POST');
            sendJson(res, 405, { error: 'Only POST is supported on /mcp (stateless mode)' });
            return;
        }

        let parsedBody: unknown;
        try {
            const raw = await readBody(req);
            parsedBody = raw ? JSON.parse(raw) : undefined;
        } catch (e) {
            sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${e}` }, id: null });
            return;
        }

        const server = buildMcpServer(this.app, this.settings);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });

        res.on('close', () => {
            void transport.close();
            void server.close();
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    }
}
