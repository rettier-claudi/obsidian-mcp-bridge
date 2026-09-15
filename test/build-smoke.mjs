import esbuild from 'esbuild';
import { readFileSync } from 'fs';
import builtins from 'builtin-modules';

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));

// 'obsidian' is not installable at runtime, so the smoke build swaps it for a stub.
const stubObsidian = {
    name: 'stub-obsidian',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: new URL('./obsidian-stub.ts', import.meta.url).pathname,
        }));
    },
};

for (const [entry, out] of [
    ['test/smoke.ts', 'test/.smoke.cjs'],
    ['test/conflicts.ts', 'test/.conflicts.cjs'],
]) {
    await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'es2022',
        define: { __PLUGIN_VERSION__: JSON.stringify(version) },
        external: [...builtins, ...builtins.map((b) => `node:${b}`)],
        plugins: [stubObsidian],
        outfile: out,
        logLevel: 'warning',
    });
}
