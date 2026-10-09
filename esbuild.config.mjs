import esbuild from "esbuild";
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";

const prod = process.argv[2] === "production";
const VAULT_PLUGIN_DIR = "test-vault/.obsidian/plugins/goodnodes";

// Excalidraw loads its fonts from "./fonts/<Family>/<file>.woff2" relative to
// EXCALIDRAW_ASSET_PATH, falling back to a CDN. Obsidian plugins ship only
// main.js/styles.css, and the iPad may be offline, so inline the fonts as data
// URLs. Xiaolai (CJK, 12 MB) is skipped and keeps the CDN fallback.
const INLINE_FONTS = /"\.\/fonts\/(Excalifont|Virgil|Nunito|Lilita|Cascadia|ComicShanns|Liberation|Assistant)\/([^"]+\.woff2)"/g;
const inlineExcalidrawFonts = {
  name: "inline-excalidraw-fonts",
  setup(build) {
    build.onLoad({ filter: /@excalidraw[\\/]excalidraw[\\/]dist[\\/]prod[\\/].*\.js$/ }, async (args) => {
      let src = await fs.promises.readFile(args.path, "utf8");
      const fontsDir = path.join(path.dirname(args.path), "fonts");
      src = src.replace(INLINE_FONTS, (_m, family, file) => {
        const b64 = fs.readFileSync(path.join(fontsDir, family, file)).toString("base64");
        return `"data:font/woff2;base64,${b64}"`;
      });
      return { contents: src, loader: "js" };
    });
  },
};

// Trim optional Excalidraw extras that would otherwise be inlined into main.js:
// the Mermaid-to-diagram importer (mermaid, katex, cytoscape: ~3 MB) and UI
// translations other than English (built in), Slovak and Czech.
const KEEP_LOCALES = /(sk-SK|cs-CZ)-/;
const trimExcalidraw = {
  name: "trim-excalidraw",
  setup(build) {
    build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({ path: "mermaid", namespace: "stub" }));
    build.onResolve({ filter: /^\.\/locales\// }, (args) =>
      KEEP_LOCALES.test(args.path) ? undefined : { path: args.path, namespace: "stub-locale" },
    );
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export async function parseMermaidToExcalidraw() { throw new Error('Mermaid import is not included in GoodNodes'); }",
      loader: "js",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-locale" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

// Obsidian loads styles.css; merge Excalidraw's CSS (emitted as main.css) with ours.
const writeStyles = {
  name: "write-styles",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      const parts = [];
      if (fs.existsSync("main.css")) parts.push(fs.readFileSync("main.css", "utf8"));
      parts.push(fs.readFileSync("src/styles.css", "utf8"));
      fs.writeFileSync("styles.css", parts.join("\n"));
      if (fs.existsSync("main.css")) fs.rmSync("main.css");
      fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(VAULT_PLUGIN_DIR, f));
      fs.writeFileSync(path.join(VAULT_PLUGIN_DIR, ".hotreload"), "");
      console.log(`[goodnodes] built ${(fs.statSync("main.js").size / 1e6).toFixed(2)} MB -> ${VAULT_PLUGIN_DIR}`);
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: { main: "src/main.ts" },
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  platform: "browser",
  target: "es2020",
  jsx: "automatic",
  conditions: ["production"],
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  logLevel: "info",
  loader: { ".woff2": "dataurl" },
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  outdir: ".",
  metafile: !!process.env.ANALYZE,
  plugins: [trimExcalidraw, inlineExcalidrawFonts, writeStyles],
});

if (prod) {
  const result = await ctx.rebuild();
  if (process.env.ANALYZE) console.log(await esbuild.analyzeMetafile(result.metafile, { verbose: false }));
  process.exit(0);
} else {
  await ctx.watch();
}
