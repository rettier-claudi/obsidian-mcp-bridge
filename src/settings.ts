import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type McpBridgePlugin from './main';

export interface McpBridgeSettings {
    /** Whether the HTTP listener should run at all. */
    enabled: boolean;
    /** Interface to bind to. 127.0.0.1 keeps it host-local; 0.0.0.0 exposes it to the container network. */
    host: string;
    port: number;
    /** Shared secret. Every request must send `Authorization: Bearer <token>`. */
    token: string;
    /**
     * Command id of the Tasks plugin's "Toggle task done". Configurable so a live
     * mismatch can be fixed in the UI instead of needing a new build.
     */
    toggleDoneCommandId: string;
}

export const DEFAULT_SETTINGS: McpBridgeSettings = {
    enabled: true,
    host: '0.0.0.0',
    port: 27125,
    token: '',
    toggleDoneCommandId: 'obsidian-tasks-plugin:toggle-done',
};

export function generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class McpBridgeSettingTab extends PluginSettingTab {
    private plugin: McpBridgePlugin;

    constructor(app: App, plugin: McpBridgePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Enable MCP server')
            .setDesc('Serve the Streamable HTTP MCP endpoint at /mcp while Obsidian is running.')
            .addToggle((t) =>
                t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
                    this.plugin.settings.enabled = v;
                    await this.plugin.saveSettings();
                    await this.plugin.restartServer();
                    this.display();
                }),
            );

        new Setting(containerEl)
            .setName('Bind address')
            .setDesc('0.0.0.0 to be reachable from other containers/hosts, 127.0.0.1 to keep it local.')
            .addText((t) =>
                t
                    .setPlaceholder('0.0.0.0')
                    .setValue(this.plugin.settings.host)
                    .onChange(async (v) => {
                        this.plugin.settings.host = v.trim() || DEFAULT_SETTINGS.host;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Port')
            .setDesc('TCP port for the MCP endpoint. Restart the server after changing.')
            .addText((t) =>
                t
                    .setPlaceholder(String(DEFAULT_SETTINGS.port))
                    .setValue(String(this.plugin.settings.port))
                    .onChange(async (v) => {
                        const n = Number.parseInt(v, 10);
                        if (Number.isFinite(n) && n > 0 && n < 65536) {
                            this.plugin.settings.port = n;
                            await this.plugin.saveSettings();
                        }
                    }),
            );

        new Setting(containerEl)
            .setName('Bearer token')
            .setDesc(
                'Every request must send this as "Authorization: Bearer <token>". ' +
                    'Without a token the server refuses to start — this endpoint can rename files and edit tasks.',
            )
            .addText((t) => {
                t.inputEl.type = 'password';
                t.inputEl.addClass('mcp-bridge-token-input');
                t.setValue(this.plugin.settings.token).onChange(async (v) => {
                    this.plugin.settings.token = v.trim();
                    await this.plugin.saveSettings();
                });
            })
            .addExtraButton((b) =>
                b
                    .setIcon('dice')
                    .setTooltip('Generate a random token')
                    .onClick(async () => {
                        this.plugin.settings.token = generateToken();
                        await this.plugin.saveSettings();
                        await this.plugin.restartServer();
                        this.display();
                    }),
            )
            .addExtraButton((b) =>
                b
                    .setIcon('copy')
                    .setTooltip('Copy token to clipboard')
                    .onClick(async () => {
                        await navigator.clipboard.writeText(this.plugin.settings.token);
                        new Notice('MCP Bridge: token copied');
                    }),
            );

        new Setting(containerEl)
            .setName('Tasks "Toggle task done" command id')
            .setDesc(
                'Command executed by complete_task. Default matches obsidian-tasks-plugin 8.x. ' +
                    'Change only if the Tasks plugin renames it.',
            )
            .addText((t) =>
                t
                    .setPlaceholder(DEFAULT_SETTINGS.toggleDoneCommandId)
                    .setValue(this.plugin.settings.toggleDoneCommandId)
                    .onChange(async (v) => {
                        this.plugin.settings.toggleDoneCommandId = v.trim() || DEFAULT_SETTINGS.toggleDoneCommandId;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Restart server')
            .setDesc(this.plugin.statusLine())
            .addButton((b) =>
                b
                    .setButtonText('Restart')
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.restartServer();
                        this.display();
                    }),
            );
    }
}
