/**
 * Just enough of the `obsidian` module for the smoke test to run under plain node.
 * esbuild aliases 'obsidian' to this file when building test/smoke.ts.
 *
 * This does NOT simulate Obsidian. It exists so the HTTP layer, the auth check,
 * the MCP handshake and the line-resolution logic can be exercised in CI-ish
 * conditions. Everything that depends on a real workspace (opening a leaf,
 * the Tasks plugin's actual toggle) is stubbed and must be verified live.
 */

export function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export class TAbstractFile {
    constructor(public path: string) {}
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export class Editor {
    constructor(private lines: string[]) {}
    getValue() {
        return this.lines.join('\n');
    }
    getLine(i: number) {
        return this.lines[i];
    }
    setLine(i: number, text: string) {
        this.lines[i] = text;
    }
    lineCount() {
        return this.lines.length;
    }
    setCursor(_pos: { line: number; ch: number }) {
        this.cursor = _pos.line;
    }
    cursor = 0;
    /** Stands in for what the Tasks plugin does to the buffer. */
    applyToggle(fn: (line: string) => string[]) {
        this.lines.splice(this.cursor, 1, ...fn(this.lines[this.cursor]));
    }
}

export class MarkdownView {
    file: TFile | null = null;
    editor!: Editor;
    saved = false;
    getMode() {
        return 'source';
    }
    getViewType() {
        return 'markdown';
    }
    getState(): Record<string, unknown> {
        return { mode: 'source' };
    }
    async setState(_s: unknown, _o: unknown) {}
    async save() {
        this.saved = true;
    }
}

export class WorkspaceLeaf {
    view: MarkdownView = new MarkdownView();
    async openFile(file: TFile, _opts?: unknown) {
        this.view.file = file;
    }
}

export class Plugin {}
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export type App = unknown;
