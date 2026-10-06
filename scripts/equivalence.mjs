/**
 * Does the generated state machine mean what the model means?
 *
 * The sandbox's saga engine is 7K's reference answer — it is what a scenario's `expect` clauses are
 * checked against, and what the specification's prose was written alongside. So the only claim worth
 * making about a generated machine is that it decides the same things.
 *
 * **Here both sides are TypeScript, which makes this strictly better than the same check for C#.**
 * That one needs a harness in another language, a script format both can read, and a decision string
 * to compare across the gap — three things that can disagree for reasons that are not about sagas.
 * This imports the generated machine and the sandbox's `Sagas` into one process and drives them from
 * one script, so the only thing that can differ is a decision.
 *
 * **Two deliberate narrowings**, both of which would otherwise show up as differences that mean
 * nothing. The stub host's `fill` generates no values: the sandbox invents one for a field a `send`
 * leaves undetermined, because it is a test harness and a scenario has to keep moving, while the
 * generated machine refuses that case at generation time. And a value is compared after normalisation,
 * so a brand and a bare string agree — the brand is a compile-time claim and this runs at runtime.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildWorkspace, qualify } from "@sevenk/core";
import { buildNames, compileRules, withDefaults } from "@sevenk/generate";
import { Sagas } from "@sevenk/sandbox";
import { node } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MODEL = join(root, "verify", "model");
const SCRIPTS = join(root, "verify", "scripts");
const OUT = join(root, ".verify", "equivalence");

/* -------------------------------------------------------------------- the model */

const sources = readdirSync(MODEL)
  .filter((f) => f.endsWith(".7k"))
  .map((f) => ({ path: f, source: readFileSync(join(MODEL, f), "utf8") }));

const workspace = buildWorkspace(sources);
const errors = workspace.diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("equivalence: the fixture model does not check out:");
  for (const e of errors) console.error(`  ${e.message}`);
  process.exit(2);
}
const model = workspace.model;

/* ------------------------------------------------------------ the generated side */

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

{
  const options = withDefaults(node.options, {});
  const rules = compileRules(model, []);
  const result = node.generate({
    model,
    selected: model.decls,
    names: buildNames(model, []).names,
    layout: "single",
    options,
    optionsFor: (decl) => rules.resolve(decl, options).options,
  });
  if (result.refusals.length > 0) {
    console.error("equivalence: generation refused, so there is nothing to compare:");
    for (const r of result.refusals) console.error(`  ${r.at}: ${r.because}`);
    process.exit(1);
  }
  for (const artifact of result.artifacts) {
    const path = join(OUT, artifact.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.content, "utf8");
  }
}

// Imported after it is written, which is the point: what runs is the artifact.
const generated = await import(pathToFileURL(join(OUT, "model.ts")).href);

/* ------------------------------------------------------------------ comparing */

/** A value in a form both sides agree on: a brand is a compile-time claim and this is runtime. */
function normalise(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalise(value[key]);
    return out;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return typeof value === "string" ? value.toLowerCase() : value;
}

const line = (parts) => parts.map((p) => (p === undefined || p === null ? "-" : String(p))).join(" | ");

const sent = (type, body) => line(["send", type, JSON.stringify(normalise(body))]);

/* ------------------------------------------------------------ the sandbox side */

const sagaNamed = (name) => {
  const found = model.decls.find((d) => d.kind === "saga" && qualify(d.id) === name);
  if (found === undefined) throw new Error(`the fixture declares no saga \`${name}\``);
  return found;
};

const serviceFor = (saga) => {
  const startId = model.resolve(saga.start.message);
  return model.decls.find(
    (d) =>
      d.kind === "service" &&
      !d.external &&
      d.id.pkg === saga.id.pkg &&
      d.reacts.some((r) => {
        const id = model.resolve(r.message);
        return id !== undefined && qualify(id) === qualify(startId);
      }),
  );
};

/** Runs one script through the sandbox's own saga engine. */
function runSandbox(script) {
  const decisions = [];
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();

  const host = {
    model,
    inScope: () => true,
    now: () => now,
    record(event) {
      switch (event.kind) {
        case "saga-started":
          decisions.push(line(["started", event.sagaKey]));
          break;
        case "saga-advanced":
          decisions.push(line(["advanced", event.step, event.message]));
          break;
        case "saga-timeout":
          decisions.push(line(["timedout", event.step]));
          break;
        case "saga-compensating":
          decisions.push(line(["compensating", event.step, event.message]));
          break;
        case "saga-irreversible":
          decisions.push(line(["irreversible", event.step]));
          break;
        case "saga-completed":
          decisions.push(line(["ended", "complete", event.step, event.detail]));
          break;
        case "saga-rejected":
          decisions.push(line(["ended", "rejected", event.step, event.detail]));
          break;
        case "saga-abandoned":
          decisions.push(line(["ended", "abandoned", event.step, event.detail]));
          break;
        default:
          break;
      }
      return { ...event, run: "equivalence", seq: decisions.length };
    },
    timer(at, run) {
      const handle = { id: nextTimer++, at, run };
      timers.set(handle.id, handle);
      return handle;
    },
    cancel(handle) {
      if (script.uncancellableTimers === true) return;
      if (handle !== undefined) timers.delete(handle.id);
    },
    send(_from, message, body) {
      decisions.push(sent(qualify(message.id), body));
      return `env-${decisions.length}`;
    },
    // Generates nothing: see the header. What the saga decided is what is compared.
    fill: (_message, written) => ({ body: { ...written }, generated: [] }),
    note: () => {},
  };

  const sagas = new Sagas(host);
  const saga = sagaNamed(script.saga);
  const service = serviceFor(saga);
  if (service === undefined) throw new Error("the fixture saga has no hosting service");

  const advanceTo = (until) => {
    for (;;) {
      const due = [...timers.values()]
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      timers.delete(next.id);
      now = next.at;
      next.run();
    }
    now = until;
  };

  const deliver = (type, body) => {
    sagas.observe(service, {
      envelope: { type, id: `in-${decisions.length}`, fields: script.envelope ?? {} },
      body,
      claims: {},
    });
  };

  deliver(script.start.type, script.start.body);
  for (const input of script.inputs) {
    if (input.deliver !== undefined) deliver(input.deliver, input.body);
    else if (input.advance !== undefined) advanceTo(now + input.advance);
  }

  return decisions;
}

/* ----------------------------------------------------------- the generated side */

/** Runs the same script through the generated machine, which is a class in this very process. */
function runGenerated(script) {
  const decisions = [];
  let now = 0;
  let nextTimer = 0;
  let timers = [];

  const machineFor = (name) => {
    const bare = name.slice(name.lastIndexOf(".") + 1);
    const cls = generated[`${bare}Saga`];
    if (cls === undefined) throw new Error(`no generated machine for \`${name}\``);
    return cls;
  };

  const perform = (effects) => {
    for (const effect of effects) {
      switch (effect.kind) {
        case "started":
          decisions.push(line(["started", effect.key]));
          break;
        case "advanced":
          decisions.push(line(["advanced", effect.step, effect.messageType]));
          break;
        case "timedOut":
          decisions.push(line(["timedout", effect.step]));
          break;
        case "compensating":
          decisions.push(line(["compensating", effect.step, effect.messageType]));
          break;
        case "irreversible":
          decisions.push(line(["irreversible", effect.step]));
          break;
        case "ended":
          decisions.push(
            line(["ended", effect.status === "complete" ? "complete" : effect.status, effect.step, effect.reason]),
          );
          break;
        case "send":
          decisions.push(sent(effect.messageType, effect.message));
          break;

        // The rest is bookkeeping a host does and a trace does not record.
        case "armTimeout":
          timers.push({ id: nextTimer++, at: now + effect.afterMs, step: effect.step, stage: effect.stage });
          break;
        case "cancelTimeout":
          if (script.uncancellableTimers !== true) timers = timers.filter((t) => t.step !== effect.step);
          break;
        case "armDeadline":
          timers.push({ id: nextTimer++, at: now + effect.afterMs, step: undefined, stage: 0 });
          break;
        case "cancelDeadline":
          if (script.uncancellableTimers !== true) timers = timers.filter((t) => t.step !== undefined);
          break;
        default:
          break;
      }
    }
  };

  const Machine = machineFor(script.saga);
  const envelopes = script.envelopeArgs ?? [];
  const { saga, effects } = Machine.start(script.start.body, ...envelopes);
  perform(effects);

  const advanceTo = (until) => {
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0];
      timers = timers.filter((t) => t.id !== next.id);
      now = next.at;
      perform(next.step === undefined ? saga.deadline() : saga.timeout(next.step, next.stage));
    }
    now = until;
  };

  for (const input of script.inputs) {
    if (input.deliver !== undefined) perform(saga.deliver(input.deliver, input.body));
    else if (input.advance !== undefined) advanceTo(now + input.advance);
  }

  return decisions;
}

/* -------------------------------------------------------------------- compare */

let failed = 0;

for (const file of readdirSync(SCRIPTS).sort()) {
  const name = file.replace(/\.json$/, "");
  const script = JSON.parse(readFileSync(join(SCRIPTS, file), "utf8"));

  const expected = runSandbox(script);
  const actual = runGenerated(script);

  const same = expected.length === actual.length && expected.every((e, i) => e === actual[i]);
  console.log(`${same ? "ok   " : "FAIL "} ${name.padEnd(22)} ${expected.length} decisions`);
  if (same) continue;

  failed++;
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const e = expected[i] ?? "(nothing)";
    const a = actual[i] ?? "(nothing)";
    console.log(`        ${e === a ? " " : "✗"} sandbox:   ${e}`);
    if (e !== a) console.log(`          generated: ${a}`);
  }
}

console.log("");
console.log(
  failed === 0
    ? "equivalence: the generated machine decides what the sandbox decides."
    : `equivalence: ${failed} script${failed === 1 ? "" : "s"} differ.`,
);
process.exit(failed === 0 ? 0 : 1);
