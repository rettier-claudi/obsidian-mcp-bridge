/**
 * `app.commands` is real and stable but not part of Obsidian's published typings.
 * Declaring only the one method we call keeps the surface honest.
 */
import 'obsidian';

declare module 'obsidian' {
    interface App {
        commands: {
            executeCommandById(id: string): boolean;
            commands: Record<string, { id: string; name: string }>;
        };
    }
}
