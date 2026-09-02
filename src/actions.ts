/**
 * The two things this bridge can do to the vault.
 *
 * Both go through Obsidian's own machinery on purpose:
 *
 *  - completeTask() does not rewrite the line itself. It puts the cursor on the
 *    task line and fires the Tasks plugin's own "Toggle task done" command, so the
 *    recurrence rules (🔁), the ✅ done date and the user's configured ordering are
 *    applied by the plugin that owns that logic. A regex in an external script can
 *    tick the box, but it cannot create the next occurrence of a recurring task —
 *    that logic lives in JS inside Obsidian and nowhere else.
 *
 *  - renameFile() calls app.fileManager.renameFile(), which rewrites every
 *    [[wikilink]] and embed pointing at the file. Renaming on disk does not.
 */

import { App, MarkdownView, TFile, TFolder, WorkspaceLeaf, normalizePath } from 'obsidian';

/** A line that Tasks would recognise as a checklist item: `- [ ] ...`, `* [x] ...`, `1. [ ] ...`. */
const TASK_LINE = /^[\s>]*(?:[-*+]|\d+\.)\s+\[.\]/;

export class ActionError extends Error {}

export interface CompleteTaskArgs {
    path: string;
    anchor?: string;
    line_number?: number;
    line_text?: string;
}

export interface CompleteTaskResult {
    path: string;
    line_number: number;
    line_before: string;
    lines_after: string[];
    recurrence_created: boolean;
    changed: boolean;
    command_id: string;
}

export interface RenameResult {
    from: string;
    to: string;
    kind: 'file' | 'folder';
    created_parent: string | null;
}

function getFile(app: App, rawPath: string): TFile {
    const path = normalizePath(rawPath);
    const af = app.vault.getAbstractFileByPath(path);
    if (!af) {
        throw new ActionError(`No such file in vault: ${path}`);
    }
    if (!(af instanceof TFile)) {
        throw new ActionError(`Not a file (it is a folder): ${path}`);
    }
    return af;
}

/**
 * Find the target line, 0-based, in `content`.
 *
 * Preference order is deliberate: the block anchor is the only identifier that
 * survives the line being edited or moved, so it wins over a line number that
 * was read from a possibly stale copy of the file.
 */
function resolveLine(content: string, args: CompleteTaskArgs): number {
    const lines = content.split('\n');

    if (args.anchor) {
        const anchor = args.anchor.replace(/^\^/, '');
        if (!/^[\w-]+$/.test(anchor)) {
            throw new ActionError(`Invalid block anchor: ${args.anchor}`);
        }
        const re = new RegExp(`(?:^|\\s)\\^${anchor}\\s*$`);
        const hits: number[] = [];
        lines.forEach((l, i) => {
            if (re.test(l)) hits.push(i);
        });
        if (hits.length === 0) {
            throw new ActionError(`Block anchor ^${anchor} not found in file`);
        }
        if (hits.length > 1) {
            throw new ActionError(
                `Block anchor ^${anchor} is not unique (lines ${hits.map((i) => i + 1).join(', ')})`,
            );
        }
        return hits[0];
    }

    if (args.line_text) {
        const needle = args.line_text.trim();
        const hits: number[] = [];
        lines.forEach((l, i) => {
            if (l.includes(needle)) hits.push(i);
        });
        if (hits.length === 0) {
            throw new ActionError(`No line containing ${JSON.stringify(needle)}`);
        }
        if (hits.length > 1) {
            throw new ActionError(
                `${hits.length} lines contain ${JSON.stringify(needle)} (lines ${hits
                    .map((i) => i + 1)
                    .join(', ')}) — pass a block anchor or a line number instead`,
            );
        }
        return hits[0];
    }

    if (typeof args.line_number === 'number') {
        const idx = args.line_number - 1; // callers count from 1, like every editor
        if (!Number.isInteger(idx) || idx < 0 || idx >= lines.length) {
            throw new ActionError(`line_number ${args.line_number} out of range (file has ${lines.length} lines)`);
        }
        return idx;
    }

    throw new ActionError('Give one of: anchor, line_text, line_number');
}

/**
 * Get the file into a MarkdownView in source mode and make that view the active
 * editor, because Tasks' "Toggle task done" is an editorCheckCallback command:
 * it operates on whatever editor Obsidian considers active, and silently does
 * nothing if that is not a MarkdownView.
 *
 * In a headless Xvfb instance nothing is normally open, so most of the time this
 * opens a fresh leaf.
 */
async function openInEditor(app: App, file: TFile): Promise<MarkdownView> {
    let leaf: WorkspaceLeaf | null = null;

    for (const candidate of app.workspace.getLeavesOfType('markdown')) {
        const view = candidate.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            leaf = candidate;
            break;
        }
    }

    if (!leaf) {
        leaf = app.workspace.getLeaf(false) ?? app.workspace.getLeaf(true);
    }

    await leaf.openFile(file, { active: true, state: { mode: 'source' } });
    app.workspace.setActiveLeaf(leaf, { focus: true });

    // Give CodeMirror a frame to attach; without this the editor can still be
    // undefined on a leaf that was created in the same tick.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
        throw new ActionError(`Could not open ${file.path} in a Markdown editor (got ${leaf.view.getViewType()})`);
    }
    if (view.getMode() !== 'source') {
        await view.setState({ ...view.getState(), mode: 'source' }, { history: false });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    return view;
}

export async function completeTask(
    app: App,
    commandId: string,
    args: CompleteTaskArgs,
): Promise<CompleteTaskResult> {
    const file = getFile(app, args.path);

    // Resolve against the on-disk content first, so an unopened file behaves the
    // same as an open one.
    const diskContent = await app.vault.read(file);
    let lineIdx = resolveLine(diskContent, args);

    const view = await openInEditor(app, file);
    const editor = view.editor;

    // The editor may hold unsaved changes that shift line numbers; re-resolve
    // against what is actually in the buffer when we have a stable identifier.
    const bufferContent = editor.getValue();
    if (bufferContent !== diskContent && (args.anchor || args.line_text)) {
        lineIdx = resolveLine(bufferContent, args);
    }

    if (lineIdx >= editor.lineCount()) {
        throw new ActionError(`Line ${lineIdx + 1} is past the end of the open buffer`);
    }

    const lineBefore = editor.getLine(lineIdx);
    if (!TASK_LINE.test(lineBefore)) {
        // Tasks' toggle command happily turns a plain line into a checklist item.
        // Refusing is better than silently reshaping a line the caller mis-addressed.
        throw new ActionError(
            `Line ${lineIdx + 1} is not a checklist task: ${JSON.stringify(lineBefore.slice(0, 120))}`,
        );
    }

    const before = editor.getValue().split('\n');
    editor.setCursor({ line: lineIdx, ch: 0 });

    const dispatched = app.commands.executeCommandById(commandId);
    if (!dispatched) {
        throw new ActionError(
            `Command ${commandId} did not run. Is the Tasks plugin enabled, and is the command id still correct?`,
        );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const after = editor.getValue().split('\n');
    const grew = Math.max(0, after.length - before.length);
    const linesAfter = after.slice(lineIdx, lineIdx + 1 + grew);

    // Flush to disk right away: callers (tasks.py, n8n) read the file next, and
    // Obsidian's own autosave would only get there seconds later.
    await view.save();

    return {
        path: file.path,
        line_number: lineIdx + 1,
        line_before: lineBefore,
        lines_after: linesAfter,
        recurrence_created: grew > 0,
        changed: after.length !== before.length || after[lineIdx] !== before[lineIdx],
        command_id: commandId,
    };
}

export async function renameFile(app: App, fromRaw: string, toRaw: string): Promise<RenameResult> {
    const from = normalizePath(fromRaw);
    const to = normalizePath(toRaw);

    if (from === to) {
        throw new ActionError('Source and target path are identical');
    }

    const source = app.vault.getAbstractFileByPath(from);
    if (!source) {
        throw new ActionError(`No such file or folder in vault: ${from}`);
    }
    if (app.vault.getAbstractFileByPath(to)) {
        throw new ActionError(`Target already exists: ${to}`);
    }

    let createdParent: string | null = null;
    const slash = to.lastIndexOf('/');
    if (slash > 0) {
        const parent = to.slice(0, slash);
        const existing = app.vault.getAbstractFileByPath(parent);
        if (!existing) {
            await app.vault.createFolder(parent);
            createdParent = parent;
        } else if (!(existing instanceof TFolder)) {
            throw new ActionError(`Target's parent is a file, not a folder: ${parent}`);
        }
    }

    // The linkbewusst part: this rewrites every [[wikilink]] and embed in the
    // vault that pointed at the old path. vault.rename() would not.
    await app.fileManager.renameFile(source, to);

    return {
        from,
        to,
        kind: source instanceof TFolder ? 'folder' : 'file',
        created_parent: createdParent,
    };
}
