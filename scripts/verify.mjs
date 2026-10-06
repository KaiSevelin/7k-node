/**
 * Does the generated TypeScript compile, and does it decode what the model says it decodes?
 *
 * Unit tests on a generator check that it emitted the string somebody expected, and what somebody
 * expected is exactly what is wrong when the mapping is wrong. So this runs `tsc` over the output with
 * every strictness the repository itself uses — a generated module that fails a consumer's own
 * `noUnusedLocals` is a module somebody excludes from the build — and then *runs* it against payloads
 * that satisfy the model and payloads that break each rule in turn.
 *
 * That second half is the point. A decoder that compiles and accepts everything is worse than no
 * decoder, because in TypeScript it is the only thing standing between `unknown` and a type that
 * claims to be checked.
 *
 * Both sides are TypeScript here, which is a real advantage over the C# provider: the behaviour
 * checks import the generated modules directly rather than going through a harness in another
 * language, so what is tested is the artifact and not a reading of it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspace } from "@sevenk/core";
import { buildNames, compileRules, withDefaults } from "@sevenk/generate";
import { node } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const OUT = join(root, ".verify");

/* -------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("verify: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}

const model = workspace.model;
const { names } = buildNames(model, []);

function emit(layout, extra = {}) {
  const suffix = Object.entries(extra)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  const dir = join(OUT, `${layout}${suffix === "" ? "" : `-${suffix}`}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Through the same defaulting the CLI uses, so the declared default is the only one there is.
  const options = withDefaults(node.options, { ...extra });
  const rules = compileRules(model, []);
  const result = node.generate({
    model,
    selected: model.decls,
    names,
    layout,
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  if (result.refusals.length > 0) {
    console.error(`verify: ${layout} refused, which the fixture should not provoke:`);
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(dir, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }

  // The settings a consumer would actually have. `noUnusedLocals` is the one that catches a
  // generated import nobody uses, which is the commonest way this provider could go wrong.
  // `extension: ""` is for a bundler, and a bundler's resolution is what it has to compile under —
  // NodeNext requires the extension, which is the whole reason the option exists.
  const bundler = extra.extension === "";

  writeFileSync(
    join(dir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: bundler ? "ESNext" : "NodeNext",
          moduleResolution: bundler ? "Bundler" : "NodeNext",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          noImplicitOverride: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { dir, files: result.artifacts.map((a) => a.path), losses: result.artifacts.flatMap((a) => a.losses) };
}

/* ------------------------------------------------------------------ compiling */

const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

function compile(dir) {
  const result = spawnSync(tsc, ["-p", dir], { encoding: "utf8", shell: process.platform === "win32" });
  const complaints = `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /error TS\d+/.test(l));
  return { ok: result.status === 0 && complaints.length === 0, complaints };
}

const COMBINATIONS = [
  ["per-declaration", {}],
  ["per-declaration", { valueTypes: "alias" }],
  ["per-declaration", { extension: "" }],
  ["per-declaration", { index: false }],
  ["per-declaration", { decoders: false }],
  ["per-package", {}],
  ["single", {}],
  ["single", { valueTypes: "alias" }],
];

let failed = 0;

for (const [layout, extra] of COMBINATIONS) {
  const { dir, files, losses } = emit(layout, extra);
  const label = `${layout}${Object.keys(extra).length === 0 ? "" : ` ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ")}`}`;
  const { ok, complaints } = compile(dir);
  if (ok) {
    const note = losses.length === 0 ? "" : `, ${losses.length} declared losses`;
    console.log(`ok    ${label.padEnd(36)} ${files.length} files${note}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
    for (const line of complaints.slice(0, 6)) console.log(`        ${line}`);
  }
}

/* ----------------------------------------------------------------- behaviour */

console.log("");

{
  // The default shape, run rather than only compiled.
  const { dir } = emit("single", {});
  cpSync(join(root, "verify", "behaviour.ts"), join(dir, "behaviour.ts"));

  const run = spawnSync(
    join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"),
    [join(dir, "behaviour.ts")],
    { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 32 * 1024 * 1024 },
  );

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
  console.log(output);
  if (run.status !== 0) failed++;
}

console.log("");
console.log(
  failed === 0
    ? "verify: the generated TypeScript compiles under a consumer's own strictness, and decodes what the model says."
    : `verify: ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
