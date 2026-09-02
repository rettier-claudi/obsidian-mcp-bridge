import esbuild from 'esbuild';
import builtins from 'builtin-modules';

// 'obsidian' is not installable at runtime, so the smoke build swaps it for a stub.
const stubObsidian = {
    name: 'stub-obsidian',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
            path: new URL('./obsidian-stub.ts', import.meta.url).pathname,
        }));
    },
};

await esbuild.build({
    entryPoints: ['test/smoke.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    external: [...builtins, ...builtins.map((b) => `node:${b}`)],
    plugins: [stubObsidian],
    outfile: 'test/.smoke.cjs',
    logLevel: 'warning',
});
