/**
 * Does the generated decoder decode what the model means?
 *
 * 7K Core's contract runtime is the reference answer. It is what `publish` is checked against, what the
 * sandbox rejects a payload with on receipt, and what Spider's composer calls a body valid by — so a
 * generated decoder that disagrees with it is wrong, whatever its own tests say. `verify/behaviour.ts`
 * already checks the decoders against hand-written expectations, which proves they do what their author
 * thought; this proves they do what the *model* says, which is a different claim and the one that
 * matters.
 *
 * ### Why this comparison is tighter than the C# provider's
 *
 * There, a generated validator only adds the rules the type system cannot carry, so the comparison has
 * to drop everything structural: a missing required property will not compile and a `Guid` cannot hold
 * `"not-a-uuid"`. Here the decoder takes `unknown` and is the whole of the checking, so *shape is in
 * scope* — a missing field, an undeclared field, a `null` where an absent field was meant, a string
 * where a number goes. Those are the cases a decoder exists for, and they are compared rather than
 * narrowed away.
 *
 * Paths match too. A decoder builds its path as it walks a value, so it says `items[0].sku` exactly as
 * Core does — where C# can only say `items[].sku`, a static path having no index in it.
 *
 * ### The two narrowings that remain
 *
 * **The prose.** Core says "length 25 exceeds the declared maximum 24"; the decoder says "length 1..24".
 * The same finding in two vocabularies, and insisting they match word for word would be insisting one
 * of them write the other's messages. What is compared is the field and the rule kind.
 *
 * **The order.** Two walks visit fields in their own order and nothing in the model says which.
 *
 * Normalisation is not applied on either side: `normalize upper` happens on receipt, before validation,
 * so a payload here carries already-normalised values and the two sides see the same bytes.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { buildWorkspace, qualify, specOfDecl, validate } from "@sevenk/core";
import { buildNames, compileRules, withDefaults } from "@sevenk/generate";
import { node } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const PAYLOADS = join(root, "verify", "payloads");
const OUT = join(root, ".verify", "decoding");

/* ------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("decoding: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}
const model = workspace.model;

/* -------------------------------------------------------------- what to compare */

/**
 * The rule a problem is about, from either side's words.
 *
 * The decoder names the kind first — `length 1..24`, `multipleOf 5`, `invariant ...` — so its first
 * token is the answer. Core writes prose, so this is a table over it: explicit, ordered, and total,
 * because a sentence this does not recognise must be a loud `?` rather than a quiet match. `length` and
 * `size` come before `range` on purpose: their messages end in the same words.
 */
const CORE_KINDS = [
  [/^length \d+ (is below|exceeds)/, "length"],
  [/^size \d+ (is below|exceeds)/, "size"],
  [/does not match /, "pattern"],
  [/is not a multiple of /, "multipleOf"],
  [/declared unique/, "unique"],
  [/(is below the declared minimum|exceeds the declared maximum)/, "range"],
  [/^the invariant /, "invariant"],
  // Shape and kernel form, which this provider does check — so they are compared, not dropped.
  [/^required field is absent$/, "absent"],
  [/^not a declared field$/, "undeclared"],
  [/^expected one of /, "type"],
  [/^expected an? /, "type"],
  [/^expected /, "type"],
  // Its own kind rather than folded into `type`: `01-kernel.md` 7.2 makes `null` never valid input,
  // which is a different claim from "the wrong type" and worth seeing separately.
  [/^null is never valid input/, "null"],
];

/** The same, over the decoder's own rule strings. */
const NODE_KINDS = [
  [/^length /, "length"],
  [/^size /, "size"],
  [/^pattern /, "pattern"],
  [/^multipleOf /i, "multipleOf"],
  [/^unique/, "unique"],
  [/^range /, "range"],
  [/^invariant /, "invariant"],
  [/required/, "absent"],
  [/undeclared|not declared|unknown field/, "undeclared"],
  [/^expected /, "type"],
  [/^a member of /, "type"],
  [/null/, "null"],
];

const kindBy = (table, text) => {
  for (const [pattern, kind] of table) if (pattern.test(text)) return kind;
  return `?(${text})`;
};

const key = (path, kind) => `${path || "(root)"} | ${kind}`;

/* --------------------------------------------------------------- the reference */

const byName = new Map(model.decls.map((d) => [qualify(d.id), d]));

function fromCore(type, body) {
  const decl = byName.get(type);
  if (decl === undefined) throw new Error(`the fixture declares no \`${type}\``);
  return validate(model, specOfDecl(model, decl, [], 0), body)
    .map((p) => key(p.path, kindBy(CORE_KINDS, p.message)))
    .sort();
}

/* --------------------------------------------------------------- the generated */

/**
 * Emits the provider's output and imports it.
 *
 * No subprocess and no protocol, which the C# harness needs and this one does not: both sides are
 * TypeScript, so what runs is the artifact itself rather than a reading of it across a pipe. `tsx`
 * loads the generated `.ts` the way a consumer's build would.
 */
async function decoders() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const { names } = buildNames(model, []);
  const options = withDefaults(node.options, {});
  const rules = compileRules(model, []);
  const result = node.generate({
    model,
    selected: model.decls,
    names,
    layout: "single",
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });

  if (result.refusals.length > 0) {
    console.error("decoding: generation refused, so there is nothing to compare:");
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }

  for (const artifact of result.artifacts) {
    const path = join(OUT, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }

  const entry = result.artifacts.find((a) => a.path.endsWith("model.ts")) ?? result.artifacts[0];
  return import(pathToFileURL(join(OUT, entry.path)).href);
}

const generated = await decoders();

/** `shop.PlaceOrder` becomes `decodePlaceOrder`, which is the provider's own naming. */
const decoderFor = (type) => {
  const name = `decode${type.slice(type.lastIndexOf(".") + 1)}`;
  const fn = generated[name];
  if (typeof fn !== "function") throw new Error(`the generated module exports no \`${name}\``);
  return fn;
};

function fromNode(type, body) {
  const decoded = decoderFor(type)(body);
  if (decoded.ok) return [];
  return decoded.problems.map((p) => key(p.path, kindBy(NODE_KINDS, p.rule))).sort();
}

/* ------------------------------------------------- differences with a reason */

/**
 * Payloads where the two differ for a reason neither side is wrong about.
 *
 * Kept visible rather than deleted: a case dropped from the fixture is a case nobody thinks about
 * again, and each of these is a question the specification has opened and the implementation has not
 * closed. They are reported as `known` and do not fail the run.
 */
const KNOWN = {
  "undeclared-field":
    "`02-contract.md` 5.4 makes tolerant reading the consumer's rule — \"minor changes are " +
    "additive, so unknown fields are ignored\" — and 6.3 reserves `strict` for a boundary pipe, " +
    "whose input is untrusted. The decoder reads tolerantly, which is right for a consumer. Core " +
    "reads strictly, which is right for a scenario's hand-typed body. Neither takes a mode, so " +
    "neither can be right for both, and which applies is a property of the pipe.",
};

/* -------------------------------------------------------------------- compare */

let failed = 0;
let known = 0;

for (const file of readdirSync(PAYLOADS).sort()) {
  const name = file.replace(/\.json$/, "");
  const { type, body } = JSON.parse(readFileSync(join(PAYLOADS, file), "utf8"));

  const expected = fromCore(type, body);
  let actual;
  try {
    actual = fromNode(type, body);
  } catch (failure) {
    // Said rather than swallowed: a decoder that threw is a different fact from one that found
    // nothing, and a harness that could not tell them apart would report a crash as agreement.
    actual = [`!! ${failure instanceof Error ? failure.message : String(failure)}`];
  }

  const same = expected.length === actual.length && expected.every((e, i) => e === actual[i]);
  const count = expected.length === 0 ? "valid" : `${expected.length} problem${expected.length === 1 ? "" : "s"}`;
  const why = Object.prototype.hasOwnProperty.call(KNOWN, name) ? KNOWN[name] : undefined;

  if (same) {
    console.log(`ok    ${name.padEnd(20)} ${count}`);
    if (why !== undefined) {
      console.log(`      — listed as a known difference and no longer one. Remove it from KNOWN.`);
      failed++;
    }
    continue;
  }

  if (why !== undefined) {
    known++;
    console.log(`known ${name.padEnd(20)} ${count}`);
    for (const line of why.match(/.{1,96}(\s|$)/g) ?? [why]) console.log(`        ${line.trim()}`);
    continue;
  }

  failed++;
  const rows = Math.max(expected.length, actual.length);
  for (let i = 0; i < rows; i++) {
    const e = expected[i] ?? "(nothing)";
    const a = actual[i] ?? "(nothing)";
    console.log(`        ${e === a ? " " : "✗"} core: ${e}`);
    if (e !== a) console.log(`          node: ${a}`);
  }
}

/* ------------------------------------------------- every kind, at least once */

// A harness that compared nothing would pass. So it says what it exercised, and fails if the fixture
// stops covering a kind — which is how `multipleOf` turned out to be in none of it.
const covered = new Set();
for (const file of readdirSync(PAYLOADS)) {
  const { type, body } = JSON.parse(readFileSync(join(PAYLOADS, file), "utf8"));
  for (const one of fromCore(type, body)) covered.add(one.split(" | ")[1]);
}
const wanted = [
  "length",
  "size",
  "range",
  "multipleOf",
  "pattern",
  "unique",
  "invariant",
  "absent",
  "undeclared",
  "type",
  "null",
];
const missing = wanted.filter((k) => !covered.has(k));
const unknown = [...covered].filter((k) => k.startsWith("?("));

console.log("");
console.log(`kinds exercised: ${wanted.filter((k) => covered.has(k)).join(", ")}`);
if (missing.length > 0) console.log(`NOT exercised:   ${missing.join(", ")}`);
for (const one of unknown) console.log(`unrecognised:    ${one}`);

const ok = failed === 0 && missing.length === 0 && unknown.length === 0;
console.log("");
console.log(
  ok
    ? `decoding: the generated decoders find what Core finds${known === 0 ? "" : `, bar ${known} known difference${known === 1 ? "" : "s"}`}.`
    : `decoding: ${failed} payload${failed === 1 ? "" : "s"} differ${missing.length + unknown.length > 0 ? ", and the fixture does not cover everything" : ""}.`,
);
process.exit(ok ? 0 : 1);
