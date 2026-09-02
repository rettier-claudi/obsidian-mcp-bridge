import { Notice, Plugin } from 'obsidian';
import { BridgeHttpServer } from './server';
import { DEFAULT_SETTINGS, McpBridgeSettingTab, McpBridgeSettings, generateToken } from './settings';

export default class McpBridgePlugin extends Plugin {
    settings: McpBridgeSettings = { ...DEFAULT_SETTINGS };
    private server: BridgeHttpServer | null = null;
    private lastError: string | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        // A vault with a rename-and-edit endpoint must not come up open. On first
        // run we mint a token instead of starting without one; the user copies it
        // out of the settings tab.
        if (!this.settings.token) {
            this.settings.token = generateToken();
            await this.saveSettings();
        }

        this.addSettingTab(new McpBridgeSettingTab(this.app, this));

        this.addCommand({
            id: 'restart-server',
            name: 'Restart MCP server',
            callback: async () => {
                await this.restartServer();
                new Notice(`MCP Bridge: ${this.statusLine()}`);
            },
        });

        this.addCommand({
            id: 'show-status',
            name: 'Show MCP server status',
            callback: () => new Notice(`MCP Bridge: ${this.statusLine()}`),
        });

        // Wait for layout: opening files in leaves needs a workspace, and on a
        // headless start the layout is not ready during onload.
        this.app.workspace.onLayoutReady(() => {
            void this.restartServer();
        });
    }

    async onunload(): Promise<void> {
        await this.server?.stop();
        this.server = null;
    }

    async restartServer(): Promise<void> {
        await this.server?.stop();
        this.server = null;
        this.lastError = null;

        if (!this.settings.enabled) return;

        const server = new BridgeHttpServer(this.app, this.settings);
        try {
            await server.start();
            this.server = server;
            console.log(
                `[obsidian-mcp-bridge] listening on http://${this.settings.host}:${this.settings.port}/mcp`,
            );
        } catch (e) {
            this.lastError = e instanceof Error ? e.message : String(e);
            console.error('[obsidian-mcp-bridge] could not start', e);
            new Notice(`MCP Bridge failed to start: ${this.lastError}`);
        }
    }

    statusLine(): string {
        if (!this.settings.enabled) return 'disabled in settings';
        if (this.lastError) return `not running — ${this.lastError}`;
        if (this.server?.listening) {
            return `listening on http://${this.settings.host}:${this.settings.port}/mcp`;
        }
        return 'not running';
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
