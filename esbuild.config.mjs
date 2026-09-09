import esbuild from 'esbuild';
import process from 'process';
import { readFileSync } from 'fs';
import builtins from 'builtin-modules';

// One version, one place. It used to be typed out again as a constant in
// server.ts, and on 2026-09-09 a release shipped with the old number there —
// /health kept reporting 0.1.2 while the built plugin was 0.1.3, which is
// exactly the signal used to check whether a deploy landed.
const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));

const banner = `/*
Bundled build of obsidian-mcp-bridge. Edit the TypeScript in src/, not this file.
*/
`;

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
    banner: { js: banner },
    define: { __PLUGIN_VERSION__: JSON.stringify(version) },
    entryPoints: ['src/main.ts'],
    bundle: true,
    // The MCP SDK ships ESM; Obsidian loads plugins as CommonJS.
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    external: [
        'obsidian',
        'electron',
        '@codemirror/autocomplete',
        '@codemirror/collab',
        '@codemirror/commands',
        '@codemirror/language',
        '@codemirror/lint',
        '@codemirror/search',
        '@codemirror/state',
        '@codemirror/view',
        '@lezer/common',
        '@lezer/highlight',
        '@lezer/lr',
        ...builtins,
        ...builtins.map((b) => `node:${b}`),
    ],
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    minify: prod,
    outfile: 'main.js',
});

if (prod) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}
