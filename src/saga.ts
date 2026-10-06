/**
 * Sagas, as state machines.
 *
 * This is the one place a provider generates logic rather than shape, and it is generated because the
 * model genuinely states it: `04-process.md` says which message starts an instance, what it keys on,
 * what each step sends and awaits, what every outcome does to the state, when it times out, what
 * reverses it, and what the terminals send. None of that is a decision left to an implementer — it is
 * *the* decision, written down, and a hand-written saga is a transcription of it.
 *
 * **The machine is pure.** It holds no clock, opens no connection and sends nothing: each input returns
 * an ordered list of effects and the host performs them. That is what makes it testable without
 * infrastructure, and it is also why `npm run equivalence` can drive this machine and the sandbox's own
 * saga engine from one script **in one process** — both are TypeScript, so there is no bridge in
 * between and nothing to disagree about but the decisions themselves.
 *
 * **The effect order is the trace order.** The sandbox announces a terminal, *then* compensates,
 * because that is the causality — it rejected and therefore it unwound.
 *
 * **Compensation runs for completed steps only, in reverse** (`04-process.md` 1.4).
 */

import type {
  AssignIr,
  AssignSource,
  Decl,
  FieldIr,
  MessageIr,
  SagaAction,
  SagaIr,
  SendIr,
  StepIr,
  Terminal,
  TypeIr,
} from "@sevenk/core";
import type { Loss } from "@sevenk/generate";
import { camel, pascal, qualified, tsType, type Context, type TypeProblem } from "./types.js";

export interface Machine {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  readonly problems: readonly TypeProblem[];
  readonly needs: ReadonlySet<string>;
  /** Kernel aliases the machine refers to: a state field of `uuid` needs the `Uuid` it is. */
  readonly kernel: ReadonlySet<string>;
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `  ${l}`));

const quote = (text: string): string => JSON.stringify(text);

const need = (pkg: string, name: string): string => `${pkg}|${name}`;

/** The kernel aliases a rendered type might mention. None is a substring of another. */
const KERNEL_NAMES = ["Uuid", "Instant", "Duration", "CivilDate", "Base64Url", "Decimal", "Branded"];

function wrap(text: string, width = 104): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

const doc = (paragraphs: readonly string[]): string[] => [
  "/**",
  ...paragraphs.flatMap((p, i) => [...(i === 0 ? [] : [" *"]), ...wrap(p).map((l) => ` * ${l}`)]),
  " */",
];

/* ------------------------------------------------------------------- support */

/**
 * The types every generated machine shares.
 *
 * `SagaEffect` is a discriminated union, which is what TypeScript has and C# does not: a host
 * switching on `kind` is narrowed and told by the compiler when a kind it does not handle appears.
 */
export const SAGA_RUNTIME = [
  "/** Where a saga instance got to. */",
  'export type SagaStatus = "running" | "complete" | "rejected" | "abandoned";',
  "",
  "/**",
  " * One thing a saga decided. A machine returns these in order and performs none of them.",
  " *",
  " * The order is the order a trace records: a terminal is announced before the compensation it",
  " * causes. A host that reorders them will send the right messages and log the wrong story.",
  " */",
  "export type SagaEffect =",
  "  /** Publish this message, on the route the model's `emits` declares for it. */",
  "  | {",
  '      readonly kind: "send";',
  "      /** The message, fully built from the instance. */",
  "      readonly message: unknown;",
  "      /** Its qualified 7K name, for a trace. */",
  "      readonly messageType: string;",
  "      /** What asked for it: `step charge`, `undo of charge`, `on reject`. */",
  "      readonly why: string;",
  "    }",
  "  /** A new instance began. */",
  '  | { readonly kind: "started"; readonly key: string }',
  "  /** An awaited message matched a waiting step. */",
  '  | { readonly kind: "advanced"; readonly step: string; readonly messageType: string }',
  "  /** A step's timeout elapsed before its reply arrived. */",
  '  | { readonly kind: "timedOut"; readonly step: string; readonly afterMs: number }',
  "  /** A completed step is being reversed. */",
  '  | { readonly kind: "compensating"; readonly step: string; readonly messageType: string }',
  "  /** A completed step declared `undo none`, so it stays done. */",
  '  | { readonly kind: "irreversible"; readonly step: string }',
  "  /** The instance reached a terminal. `step` is absent when a deadline ended it. */",
  "  | {",
  '      readonly kind: "ended";',
  "      readonly status: SagaStatus;",
  "      readonly step?: string;",
  "      readonly reason?: string;",
  "    }",
  "  /**",
  "   * Arm a timer that calls `timeout(step, stage)` after `afterMs`. `stage` is what makes a timer",
  "   * firing after its step already joined harmless.",
  "   */",
  '  | { readonly kind: "armTimeout"; readonly step: string; readonly stage: number; readonly afterMs: number }',
  "  /** Cancel the timer armed for this step, if it is still pending. */",
  '  | { readonly kind: "cancelTimeout"; readonly step: string }',
  "  /** Arm a timer that calls `deadline()` after `afterMs`. */",
  '  | { readonly kind: "armDeadline"; readonly afterMs: number }',
  "  /** Cancel the deadline timer. */",
  '  | { readonly kind: "cancelDeadline" };',
  "",
  "/**",
  " * What every generated machine offers, so a host can drive one without knowing which.",
  " *",
  " * Starting an instance is not here, because the message that starts one is the saga's own and a",
  " * typed `start` is the point. Everything after that is uniform.",
  " */",
  "export interface SagaMachine {",
  "  /** The instance key, which is not the correlation id (`04-process.md` 1.1). */",
  "  readonly key: string;",
  "  /** Where it got to. */",
  "  readonly status: SagaStatus;",
  "  /** The reason it ended, where the terminal carried one. */",
  "  readonly reason: string | undefined;",
  "  /** Which stage is running. Steps written in one `parallel` block share a stage. */",
  "  readonly stage: number;",
  "  /** The steps that completed, in the order they did, which is the order compensation reverses. */",
  "  readonly completed: readonly string[];",
  "  /** The branches of the current stage that have not joined yet. */",
  "  readonly waiting: readonly string[];",
  "  /** Where the instance is, as the model names it. */",
  "  readonly stateName: string;",
  "  /** Whether a name describes where this instance is. */",
  "  isIn(name: string): boolean;",
  "  /** Delivers a message, if any waiting step awaits it. Empty means nothing wanted it. */",
  "  deliver(messageType: string, message: unknown): readonly SagaEffect[];",
  "  /** A step's timer fired, in the stage it was armed in. */",
  "  timeout(step: string, stage: number): readonly SagaEffect[];",
  "  /** The saga's deadline elapsed. */",
  "  deadline(): readonly SagaEffect[];",
  "}",
];

export const SAGA_MODULE = "saga";

/* ------------------------------------------------------------------- reading */

interface Read {
  readonly expr?: string;
  readonly why?: string;
}

const fieldsOf = (decl: Decl): readonly FieldIr[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope" ? decl.fields : [];

/** The field a path names on a declaration, where it names one. */
function fieldAt(decl: Decl | undefined, path: readonly string[], ctx: Context): FieldIr | undefined {
  if (decl === undefined || path.length === 0) return undefined;
  const field = fieldsOf(decl).find((f) => f.name === path[0]);
  if (field === undefined || path.length === 1) return field;
  const next: Decl | undefined = field.type.t === "ref" ? ctx.model.declFor(field.type.ref) : undefined;
  return fieldAt(next, path.slice(1), ctx);
}

const property = (path: readonly string[]): string => path.map((p) => `.${p}`).join("");

interface Site {
  readonly saga: SagaIr;
  readonly ctx: Context;
  readonly envelopes: readonly Decl[];
  readonly problems: TypeProblem[];
  readonly losses: Loss[];
  readonly needs: Set<string>;
  readonly kernel: Set<string>;
}

/** An envelope field, looked up across the records the package declares. */
function envelopeField(site: Site, path: readonly string[]): { decl: Decl; field: FieldIr } | undefined {
  for (const decl of site.envelopes) {
    const field = fieldAt(decl, path, site.ctx);
    if (field !== undefined) return { decl, field };
  }
  return undefined;
}

/**
 * What a `send` block's assignment reads.
 *
 * A send has the instance and nothing else in hand, which is why `message` and `claim` yield nothing
 * here: naming one is a model error, and the sandbox leaves the field unset and says so rather than
 * inventing a reading. This does the same, except at generation time.
 */
function readForSend(site: Site, source: AssignSource, terminal: Terminal | undefined): Read {
  switch (source.from) {
    case "absent":
      return { why: "it is `absent`, which clears a field rather than filling one" };

    case "literal":
      return { expr: JSON.stringify(source.value) };

    case "state":
    case "path": {
      const field = site.saga.state.find((f) => f.name === source.path[0]);
      if (field === undefined) {
        return { why: `the saga declares no state field \`${source.path[0] ?? ""}\`` };
      }
      return { expr: `required(this.state${property(source.path)}, ${quote(source.path.join("."))})` };
    }

    case "envelope": {
      const found = envelopeField(site, source.path);
      if (found === undefined) {
        return { why: `no envelope of \`${site.saga.id.pkg}\` declares \`${source.path.join(".")}\`` };
      }
      const held = `this.${camel(found.decl.id.name)}${property(source.path)}`;
      return {
        expr: found.field.optional ? `required(${held}, ${quote(source.path.join("."))})` : held,
      };
    }

    case "terminal": {
      if (terminal === undefined) return { why: "`terminal` is only in hand for a terminal `send`" };
      if (source.path[0] === "state") return { expr: quote(terminal) };
      if (source.path[0] === "reason") return { expr: `required(this.reason, "terminal.reason")` };
      return { why: `\`terminal.${source.path.join(".")}\` is not a thing a terminal carries` };
    }

    default:
      return { why: `a \`send\` block cannot read \`${source.from}\`: it has the instance and nothing else` };
  }
}

/** What an `on` action's assignment reads: the message that arrived, its envelope, or a literal. */
function readForAction(site: Site, source: AssignSource, message: MessageIr): Read {
  switch (source.from) {
    case "absent":
      return { expr: "undefined" };

    case "literal":
      return { expr: JSON.stringify(source.value) };

    case "message": {
      const field = fieldAt(message, source.path, site.ctx);
      if (field === undefined) {
        return { why: `\`${qualified(message)}\` declares no \`${source.path.join(".")}\`` };
      }
      return { expr: `message${property(source.path)}` };
    }

    case "envelope": {
      const found = envelopeField(site, source.path);
      if (found === undefined) {
        return { why: `no envelope of \`${site.saga.id.pkg}\` declares \`${source.path.join(".")}\`` };
      }
      return { expr: `this.${camel(found.decl.id.name)}${property(source.path)}` };
    }

    default:
      // The sandbox reads claims here, and a saga is handed none (D69) — so it reads nothing.
      return {
        why: `an \`on\` action cannot read \`${source.from}\`: a saga presents no identity of its own (D69)`,
      };
  }
}

/* --------------------------------------------------------------------- sends */

/**
 * The expression that builds one message a saga sends.
 *
 * Three sources, in the order the language gives them authority. What the `send` block says wins,
 * because the author said it. Then the `@role(businessKey)` field takes the instance key, which is what
 * makes the eventual reply correlate back. Then any other field takes a state field of the same name.
 *
 * Whatever is left is the interesting case. The sandbox generates a value for it, because it is a test
 * harness and a scenario has to keep moving. This cannot: the generated interfaces have required
 * fields, and a generated amount is a guess with a model behind it. So it is refused, naming the field.
 */
function buildSend(
  site: Site,
  send: SendIr,
  terminal: Terminal | undefined,
  why: string,
): string[] | undefined {
  const decl = site.ctx.model.declFor(send.message);
  if (decl === undefined || decl.kind !== "message") return undefined;
  site.needs.add(need(decl.id.pkg, pascal(decl.id.name)));

  const assigned = new Map<string, string>();

  for (const assign of send.assigns) {
    const target = assign.target[0];
    if (target === undefined || assign.target.length > 1) continue;
    const field = decl.fields.find((f) => f.name === target);
    if (field === undefined) continue;

    const read = readForSend(site, assign.source, terminal);
    if (read.expr === undefined) {
      site.problems.push({
        at: `${site.saga.id.name}.${why}`,
        declared: `\`${target} = …\` on \`${qualified(decl)}\``,
        because: `This provider cannot read that: ${read.why ?? "the source is not available here"}.`,
      });
      continue;
    }
    assigned.set(target, coerce(field.type, read.expr, assign.source, site));
  }

  const missing: string[] = [];
  for (const field of decl.fields) {
    if (assigned.has(field.name)) continue;

    if (field.role === "businessKey") {
      // The key is a string, and the field's type is whatever the model says it is.
      assigned.set(field.name, `(this.key as ${rendered(field.type, site)})`);
      continue;
    }

    const held = site.saga.state.find((f) => f.name === field.name);
    if (held !== undefined) {
      assigned.set(field.name, `required(this.state.${field.name}, ${quote(field.name)})`);
      continue;
    }

    if (field.optional) continue;
    missing.push(field.name);
  }

  if (missing.length > 0) {
    site.problems.push({
      at: `${site.saga.id.name}.${why}`,
      declared: `\`send ${qualified(decl)}\` without ${missing.map((m) => `\`${m}\``).join(", ")}`,
      because:
        `Nothing determines ${missing.length === 1 ? "that field" : "those fields"}: the \`send\` block ` +
        `does not assign ${missing.length === 1 ? "it" : "them"}, ${missing.length === 1 ? "it is" : "they are"} ` +
        `not the business key, and the saga holds no state of that name. The generated interface requires ` +
        `${missing.length === 1 ? "it" : "them"}, and a generated value would be a guess — add the ` +
        `assignment to the model.`,
    });
    return undefined;
  }

  const fields = decl.fields
    .filter((f) => assigned.has(f.name))
    .map((f) => `${f.name}: ${assigned.get(f.name)!},`);

  return [
    `kind: "send",`,
    `message: {`,
    ...indent(fields),
    `} satisfies ${pascal(decl.id.name)},`,
    `messageType: ${quote(qualified(decl))},`,
    `why: ${quote(why)},`,
  ];
}

/**
 * A type as the generated modules write it, remembering what that costs in imports.
 *
 * A state field of `uuid` is a `Uuid`, which is a kernel alias — rendering it as `unknown` compiled
 * and then would not let the value back out, which is the bug this replaced.
 */
const rendered = (type: TypeIr, site: Site): string => {
  const decl = type.t === "ref" ? site.ctx.model.declFor(type.ref) : undefined;
  if (decl !== undefined) {
    // An aliased value exports nothing of its own, so the type it refines is what is written.
    if (decl.kind === "value" && site.ctx.valueTypes === "alias") {
      return rendered(decl.base, site);
    }
    site.needs.add(need(decl.id.pkg, pascal(decl.id.name)));
    return pascal(decl.id.name);
  }
  const text = tsType(type, site.ctx, site.saga.id.name);
  site.problems.push(...text.problems);
  for (const name of ["Uuid", "Instant", "Duration", "CivilDate", "Base64Url", "Decimal", "Branded"]) {
    // `includes`, deliberately: none of these is a substring of another, and a word boundary written
    // into a template literal is the backspace escape rather than `\b` — which matched nothing, so
    // the kernel imports came out empty and the module would not compile.
    if (text.text.includes(name)) site.kernel.add(name);
  }
  return text.text;
};

/**
 * Fits a value to the field it is going into.
 *
 * Only where the model's own types make it necessary. `terminal.reason` is a plain string and a field
 * it goes into is usually a branded one, so the brand has to be put back on — and a cast is the only
 * way, because the value came from the model rather than from a decoder.
 */
function coerce(type: TypeIr, expr: string, source: AssignSource, site: Site): string {
  const stringish = source.from === "terminal" || (source.from === "literal" && typeof source.value === "string");
  if (!stringish || type.t !== "ref") return expr;
  const decl = site.ctx.model.declFor(type.ref);
  if (decl?.kind !== "value") return expr;
  // Asserted rather than decoded: the value came from the model, which the checker already read.
  // `rendered` is what decides whether that is a brand or the type it refines.
  return `(${expr} as ${rendered(type, site)})`;
}

/* -------------------------------------------------------------------- stages */

const stagesOf = (saga: SagaIr): number[] =>
  [...new Set(saga.steps.map((s) => s.stage))].sort((a, b) => a - b);

const stepsIn = (saga: SagaIr, stage: number): StepIr[] => saga.steps.filter((s) => s.stage === stage);

/** `continue`, `reject` or `abandon`, as the sandbox applies them. */
function applyAction(
  site: Site,
  step: StepIr,
  action: SagaAction,
  message: MessageIr | undefined,
): string[] {
  const lines: string[] = [`effects.push({ kind: "cancelTimeout", step: ${quote(step.name)} });`];

  switch (action.a) {
    case "continue": {
      if (message !== undefined) {
        for (const assign of action.assigns) {
          const head = assign.target[0];
          if (head === undefined) continue;
          if (site.saga.state.find((f) => f.name === head) === undefined) {
            site.problems.push({
              at: `${site.saga.id.name}.${step.name}`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `The saga declares no state field \`${head}\`.`,
            });
            continue;
          }
          const read = readForAction(site, assign.source, message);
          if (read.expr === undefined) {
            site.problems.push({
              at: `${site.saga.id.name}.${step.name}`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `This provider cannot read that: ${read.why ?? "the source is not available"}.`,
            });
            continue;
          }
          lines.push(`this.state${property(assign.target)} = ${read.expr};`);
        }
      }
      lines.push(
        "",
        "// The step succeeded, so it becomes reversible.",
        `this.done.push(${quote(step.name)});`,
        `this.joined.add(${quote(step.name)});`,
        "",
        "// A stage joins when its last branch completes; until then the siblings keep waiting.",
        "if (stepsIn(this.stage).every((s) => this.joined.has(s))) {",
        "  this.stage++;",
        "  this.enterStage(effects);",
        "}",
      );
      return lines;
    }

    case "reject":
      lines.push(
        `this.terminate(effects, "rejected", ${quote(step.name)}, ${
          action.reason === undefined ? "undefined" : quote(action.reason)
        });`,
      );
      return lines;

    default:
      // `abandon` takes no reason in the grammar, so the step that abandoned is the reason.
      lines.push(
        `this.terminate(effects, "abandoned", ${quote(step.name)}, ${quote(`abandoned in ${step.name}`)});`,
      );
      return lines;
  }
}

/* -------------------------------------------------------------------- output */

/** Everything a saga becomes. */
export function machineFor(decl: Decl, ctx: Context): Machine | undefined {
  if (decl.kind !== "saga") return undefined;
  const saga = decl;
  if (saga.start === undefined) return undefined;

  const startDecl = ctx.model.declFor(saga.start.message);
  if (startDecl === undefined || startDecl.kind !== "message") return undefined;

  const keyName = saga.start.keyedBy ?? startDecl.fields.find((f) => f.role === "businessKey")?.name;
  const keyField = keyName === undefined ? undefined : fieldAt(startDecl, keyName.split("."), ctx);

  const envelopes = (ctx.model.packages.get(saga.id.pkg)?.envelopes ?? [])
    .map((ref) => ctx.model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);

  const site: Site = {
    saga,
    ctx,
    envelopes,
    problems: [],
    losses: [],
    needs: new Set(),
    kernel: new Set(),
  };

  const name = pascal(saga.id.name);
  site.needs.add(need(startDecl.id.pkg, pascal(startDecl.id.name)));
  for (const envelope of envelopes) site.needs.add(need(envelope.id.pkg, pascal(envelope.id.name)));

  if (keyField === undefined || keyName === undefined) {
    site.problems.push({
      at: saga.id.name,
      declared: `\`start on ${qualified(startDecl)}\``,
      because:
        `Nothing keys an instance: \`${qualified(startDecl)}\` has no \`@role(businessKey)\` field and ` +
        `the saga declares no \`keyed by\`.`,
    });
    return {
      lines: [],
      losses: site.losses,
      problems: site.problems,
      needs: site.needs,
      kernel: site.kernel,
    };
  }

  const stateFields = saga.state.map((field) => `${field.name}?: ${rendered(field.type, site)};`);

  // Every message any step awaits, with the step and action that handles it.
  const awaited = saga.steps.flatMap((step) =>
    step.awaits.flatMap((a) => {
      const message = ctx.model.declFor(a.message);
      return message === undefined || message.kind !== "message" ? [] : [{ step, await: a, message }];
    }),
  );

  const byMessage = new Map<string, typeof awaited>();
  for (const one of awaited) {
    const key = qualified(one.message);
    byMessage.set(key, [...(byMessage.get(key) ?? []), one]);
  }

  const deliverBranches = [...byMessage].flatMap(([qname, handlers]) => {
    const message = handlers[0]!.message;
    site.needs.add(need(message.id.pkg, pascal(message.id.name)));

    const branches = handlers.flatMap(({ step, await: a, message: m }) => {
      const keyPath = a.keyedBy ?? m.fields.find((f) => f.role === "businessKey")?.name;
      if (keyPath === undefined) {
        site.problems.push({
          at: `${saga.id.name}.${step.name}`,
          declared: `\`on ${qualified(m)}\``,
          because:
            `Nothing correlates it: \`${qualified(m)}\` has no \`@role(businessKey)\` field and the ` +
            `\`on\` clause declares no \`keyed by\`.`,
        });
        return [];
      }
      return [
        `if (!this.joined.has(${quote(step.name)}) && stepsIn(this.stage).includes(${quote(step.name)})`,
        `    && String(message${property(keyPath.split("."))}) === this.key) {`,
        ...indent([
          `effects.push({ kind: "advanced", step: ${quote(step.name)}, messageType: ${quote(qname)} });`,
          ...applyAction(site, step, a.action, m),
          "return effects;",
        ]),
        "}",
      ];
    });

    return [
      `if (messageType === ${quote(qname)}) {`,
      ...indent([
        "// Decoded on the way in: the subscription that delivered it is generated with a decoder,",
        "// and the handler interface it satisfies takes the typed message.",
        `const message = raw as ${pascal(message.id.name)};`,
        ...branches,
      ]),
      "}",
    ];
  });

  const timeoutSteps = saga.steps.filter((s) => s.timeout !== undefined);

  /** `enterStage`, which both `start` and a joining step reach. */
  const enterStage: string[] = [
    "// A stage with no steps is the end of the saga: every stage before it joined.",
    "const steps = stepsIn(this.stage);",
    "if (steps.length === 0) {",
    '  this.terminate(effects, "complete", undefined, undefined);',
    "  return;",
    "}",
    "",
    "this.joined.clear();",
    "",
    "// Every branch is sent before any reply can arrive, which is what makes a stage concurrent",
    "// rather than a sequence written with extra words.",
    "switch (this.stage) {",
    ...stagesOf(saga).flatMap((stage) => {
      const sends = stepsIn(saga, stage).flatMap((step) => {
        if (step.send === undefined) return [];
        const built = buildSend(site, step.send, undefined, `step ${step.name}`);
        return built === undefined ? [] : ["effects.push({", ...indent(built), "});"];
      });
      return [`  case ${stage}:`, ...indent(indent(sends.length === 0 ? ["break;"] : [...sends, "break;"]))];
    }),
    "  default:",
    "    break;",
    "}",
    "",
    "// Timers after sends, so that a stage's timeouts all start from the same instant.",
    "for (const step of steps) {",
    "  const after = timeoutOf(step);",
    '  if (after !== undefined) effects.push({ kind: "armTimeout", step, stage: this.stage, afterMs: after });',
    "}",
  ];

  const unwind: string[] = [
    "for (let i = this.done.length - 1; i >= 0; i--) {",
    ...indent([
      "switch (this.done[i]) {",
      ...indent(
        saga.steps.flatMap((step) => {
          if (step.undo === undefined) return [];
          if (step.undo === null) {
            return [
              `case ${quote(step.name)}:`,
              ...indent([
                "// `undo none`: the model says this step cannot be reversed, so it stays done.",
                `effects.push({ kind: "irreversible", step: ${quote(step.name)} });`,
                "break;",
              ]),
            ];
          }
          const undoDecl = ctx.model.declFor(step.undo.message);
          if (undoDecl === undefined || undoDecl.kind !== "message") return [];
          const built = buildSend(site, step.undo, undefined, `undo of ${step.name}`);
          if (built === undefined) return [];
          return [
            `case ${quote(step.name)}:`,
            ...indent([
              `effects.push({ kind: "compensating", step: ${quote(step.name)}, messageType: ${quote(qualified(undoDecl))} });`,
              "effects.push({",
              ...indent(built),
              "});",
              "break;",
            ]),
          ];
        }),
      ),
      ...indent([
        "default:",
        "  // An absent `undo` is `uncompensated`, which the checker reports. Nothing to send.",
        "  break;",
      ]),
      "}",
    ]),
    "}",
  ];

  const terminalSends: string[] = [
    "switch (terminal) {",
    ...indent(
      (["complete", "reject", "abandon"] as const).flatMap((terminal) => {
        const found = saga.terminals.find((t) => t.on === terminal);
        if (found === undefined) return [];
        const built = buildSend(site, found.send, terminal, `on ${terminal}`);
        if (built === undefined) return [];
        const status = terminal === "complete" ? "complete" : terminal === "reject" ? "rejected" : "abandoned";
        return [
          `case ${quote(status)}:`,
          ...indent(["effects.push({", ...indent(built), "});", "break;"]),
        ];
      }),
    ),
    ...indent(["default:", "  break;"]),
    "}",
  ];

  const envelopeParams = envelopes.map((e) => `${camel(e.id.name)}: ${pascal(e.id.name)}`);

  const lines = [
    ...doc([
      `What \`${qualified(saga)}\` remembers.`,
      "Every field is optional because a saga's state is assigned only from a message it received " +
        "(D16) — before the step that assigns it, there is nothing there.",
    ]),
    `export interface ${name}State {`,
    ...indent(stateFields),
    "}",
    "",
    ...doc([
      `The steps \`${qualified(saga)}\` declares, by the stage they belong to.`,
      "Steps sharing a stage were written in one `parallel` block and run at once.",
    ]),
    `const stepsIn = (stage: number): readonly string[] =>`,
    ...indent([
      "(",
      ...indent([
        "{",
        ...indent(
          stagesOf(saga).map(
            (stage) => `${stage}: [${stepsIn(saga, stage).map((s) => quote(s.name)).join(", ")}],`,
          ),
        ),
        "} as Readonly<Record<number, readonly string[]>>",
      ]),
      ")[stage] ?? [];",
    ]),
    "",
    "/** How long each step may take, where the model bounds one. */",
    "const timeoutOf = (step: string): number | undefined =>",
    ...indent([
      "(",
      ...indent([
        "{",
        ...indent(timeoutSteps.map((s) => `${quote(s.name)}: ${s.timeout!.afterMs},`)),
        "} as Readonly<Record<string, number>>",
      ]),
      ")[step];",
    ]),
    "",
    "/**",
    " * State the model says is there by now.",
    " *",
    " * The checker proves a field is assigned before it is read (`04-process.md`), so this should never",
    " * throw — and if it does, the saga is the thing that is wrong, which is what the message says.",
    " */",
    "function required<T>(value: T | undefined, what: string): T {",
    "  if (value === undefined) {",
    `    throw new Error(\`${qualified(saga)}: \\\`\${what}\\\` is unset at this point. The model does not assign it before it is read.\`);`,
    "  }",
    "  return value;",
    "}",
    "",
    ...doc([
      `\`${qualified(saga)}\`, as a state machine.`,
      "Generated from the saga the model declares. It holds no clock and sends nothing: every input " +
        "returns the effects the saga decided, in the order a trace records them, and the host performs " +
        "them. That is what makes it testable without infrastructure, and what keeps delivery and retry " +
        "outside it where the model says they live.",
      `A host owns the instances. Look one up by \`key\` before starting: a second ` +
        `\`${qualified(startDecl)}\` with a key already held is a redundant start, which is what makes ` +
        `starting idempotent on an at-least-once pipe (\`04-process.md\` 1.1) — and only the host can ` +
        `see that.`,
    ]),
    `export class ${name}Saga implements SagaMachine {`,
    ...indent([
      `/** The saga's qualified name, as a trace carries it. */`,
      `static readonly name7k = ${quote(qualified(saga))};`,
      ...(saga.version === undefined ? [] : [`/** The declared version. */`, `static readonly version = ${quote(saga.version)};`]),
      saga.deadlineMs === undefined
        ? "/** The saga declares no deadline, so only its steps' timeouts bound it. */\n  static readonly deadlineMs: number | undefined = undefined;"
        : `/** How long the whole instance may take before it is abandoned. */\n  static readonly deadlineMs = ${saga.deadlineMs};`,
      "",
      "/** The step names the model declares, so a host need not spell them. */",
      `static readonly steps = [${saga.steps.map((s) => quote(s.name)).join(", ")}] as const;`,
      "",
      `readonly state: ${name}State = {};`,
      'status: SagaStatus = "running";',
      "reason: string | undefined;",
      "stage = 0;",
      "private readonly done: string[] = [];",
      "private readonly joined = new Set<string>();",
      "",
      `private constructor(`,
      `  readonly key: string,`,
      ...envelopes.map((e) => `  readonly ${camel(e.id.name)}: ${pascal(e.id.name)},`),
      ") {}",
      "",
      ...doc([`Begins an instance from \`${qualified(startDecl)}\`, keyed by \`${keyName}\`.`]),
      `static start(`,
      `  message: ${pascal(startDecl.id.name)},`,
      ...envelopeParams.map((p) => `  ${p},`),
      `): { saga: ${name}Saga; effects: readonly SagaEffect[] } {`,
      ...indent([
        `const saga = new ${name}Saga(String(message${property(keyName.split("."))})${
          envelopes.length === 0 ? "" : `, ${envelopes.map((e) => camel(e.id.name)).join(", ")}`
        });`,
        "const effects: SagaEffect[] = [];",
        "",
        "// The start block's assignments, before anything is announced: `started` reports an instance",
        "// that already holds what the start message gave it.",
        ...saga.start.assigns.flatMap((assign: AssignIr) => {
          const head = assign.target[0];
          if (head === undefined) return [];
          if (saga.state.find((f) => f.name === head) === undefined) {
            site.problems.push({
              at: `${saga.id.name}.start`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `The saga declares no state field \`${head}\`.`,
            });
            return [];
          }
          const read = readForAction(site, assign.source, startDecl);
          if (read.expr === undefined) {
            site.problems.push({
              at: `${saga.id.name}.start`,
              declared: `\`${assign.target.join(".")} = …\``,
              because: `This provider cannot read that: ${read.why ?? "the source is not available"}.`,
            });
            return [];
          }
          return [`saga.state${property(assign.target)} = ${read.expr};`];
        }),
        "",
        'effects.push({ kind: "started", key: saga.key });',
        ...(saga.deadlineMs === undefined
          ? []
          : [`effects.push({ kind: "armDeadline", afterMs: ${saga.deadlineMs} });`]),
        "saga.enterStage(effects);",
        "return { saga, effects };",
      ]),
      "}",
      "",
      ...doc([
        "Delivers a message, if any waiting step awaits it.",
        "Returns no effects when none does, which is not an error: another instance or another service " +
          "may be the one that wanted it.",
      ]),
      "deliver(messageType: string, raw: unknown): readonly SagaEffect[] {",
      ...indent([
        "const effects: SagaEffect[] = [];",
        'if (this.status !== "running") return effects;',
        "",
        ...deliverBranches,
        "return effects;",
      ]),
      "}",
      "",
      ...doc([
        "A step's timer fired.",
        "`stage` is the stage it was armed in, which is what makes a timer that fires after its step " +
          "already joined harmless (`04-process.md` 2.1).",
      ]),
      "timeout(step: string, stage: number): readonly SagaEffect[] {",
      ...indent([
        "const effects: SagaEffect[] = [];",
        'if (this.status !== "running") return effects;',
        "// The guard is the stage *and* the branch: a branch that joined while its siblings waited is",
        "// still in the same stage, and the timer it armed must not fire on it.",
        "if (stage !== this.stage || this.joined.has(step)) return effects;",
        "",
        "switch (step) {",
        ...indent(
          timeoutSteps.flatMap((step) => [
            `case ${quote(step.name)}:`,
            ...indent([
              `effects.push({ kind: "timedOut", step: ${quote(step.name)}, afterMs: ${step.timeout!.afterMs} });`,
              ...applyAction(site, step, step.timeout!.action, undefined),
              "break;",
            ]),
          ]),
        ),
        ...indent(["default:", "  break;"]),
        "}",
        "return effects;",
      ]),
      "}",
      "",
      ...doc(["The saga's deadline elapsed, which abandons the instance wherever it had got to."]),
      "deadline(): readonly SagaEffect[] {",
      ...indent([
        "const effects: SagaEffect[] = [];",
        'if (this.status !== "running") return effects;',
        "// No step ended it, so no step is named: that absence is how a consumer tells a failed step",
        "// from the clock running out while it waited.",
        'this.terminate(effects, "abandoned", undefined, "deadline elapsed");',
        "return effects;",
      ]),
      "}",
      "",
      "/** The branches of the current stage that have not joined yet. */",
      "get waiting(): readonly string[] {",
      "  return stepsIn(this.stage).filter((s) => !this.joined.has(s));",
      "}",
      "",
      "/** The steps that completed, in the order they did. */",
      "get completed(): readonly string[] {",
      "  return this.done;",
      "}",
      "",
      "/** Where the instance is, as the model names it. */",
      "get stateName(): string {",
      '  if (this.status !== "running") return this.status;',
      '  return this.waiting.length === 0 ? "running" : this.waiting.join(" + ");',
      "}",
      "",
      ...doc([
        "Whether a name describes where this instance is.",
        "A terminal matches the status; a step name matches a branch still awaited, so an instance in a " +
          "`parallel` block is in both of its steps.",
      ]),
      "isIn(name: string): boolean {",
      "  const wanted = name.toLowerCase();",
      '  if (this.status !== "running") return this.status === wanted;',
      "  return this.waiting.some((s) => s.toLowerCase() === wanted);",
      "}",
      "",
      "private enterStage(effects: SagaEffect[]): void {",
      ...indent(enterStage),
      "}",
      "",
      "/**",
      " * Ends the instance: announce the terminal, unwind the completed steps, then send the terminal",
      " * message. In that order, because that is the causality — it rejected and *therefore* it",
      " * compensated.",
      " */",
      "private terminate(",
      "  effects: SagaEffect[],",
      "  terminal: SagaStatus,",
      "  step: string | undefined,",
      "  reason: string | undefined,",
      "): void {",
      ...indent([
        'if (this.status !== "running") return;',
        "",
        "// Every branch's timer, not one: terminating mid-stage ends its siblings too.",
        'for (const w of this.waiting) effects.push({ kind: "cancelTimeout", step: w });',
        'effects.push({ kind: "cancelDeadline" });',
        "",
        "this.status = terminal;",
        "if (reason !== undefined) this.reason = reason;",
        'effects.push({ kind: "ended", status: terminal, ...(step === undefined ? {} : { step }), ...(reason === undefined ? {} : { reason }) });',
        "",
        'if (terminal !== "complete") this.unwind(effects);',
        "",
        "this.terminal(effects, terminal);",
      ]),
      "}",
      "",
      "/**",
      " * Reverses the completed steps, in reverse order and only those that completed. A step that",
      " * never succeeded has nothing to reverse (`04-process.md` 1.4).",
      " */",
      "private unwind(effects: SagaEffect[]): void {",
      ...indent(unwind),
      "}",
      "",
      "/** The message the reached terminal sends, where the model declares one. */",
      "private terminal(effects: SagaEffect[], terminal: SagaStatus): void {",
      ...indent(terminalSends),
      "}",
    ]),
    "}",
  ];

  return { lines, losses: site.losses, problems: site.problems, needs: site.needs, kernel: site.kernel };
}
