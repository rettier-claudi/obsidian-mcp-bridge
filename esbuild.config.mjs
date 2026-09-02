import esbuild from 'esbuild';
import process from 'process';
import builtins from 'builtin-modules';

const banner = `/*
Bundled build of obsidian-mcp-bridge. Edit the TypeScript in src/, not this file.
*/
`;

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
    banner: { js: banner },
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
