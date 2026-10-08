/**
 * A declaration, as a type and the decoder that produces it.
 *
 * The two are generated together on purpose. A type without a decoder is a claim nobody checked, and in
 * TypeScript that claim is free — `JSON.parse(body) as PlaceOrder` compiles and is wrong. So every
 * exported type here has exactly one way into it, and that way is a function returning either the value
 * or the reasons it is not one.
 */

import { intIsWide } from "@sevenk/core";
import type {
  ConstraintIr,
  Decl,
  EnumIr,
  FieldIr,
  MessageIr,
  Predicate,
  RecordIr,
  TypeIr,
  ValueIr,
} from "@sevenk/core";
import type { Loss } from "@sevenk/provider";
import type { HandlerSymbol } from "./handlers.js";
import {
  chainOf,
  checksFor,
  fieldsOf,
  indent,
  invariantsOf,
  quote,
  shapeOf,
  throughOf,
} from "./decode.js";
import { declOf, intLoss, pascal, tsType, type Context, type TypeProblem } from "./types.js";

export interface Emitted {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  readonly problems: readonly TypeProblem[];
  /** Type names from other packages this module refers to. */
  readonly needs: ReadonlySet<string>;
  /** Kernel aliases this module refers to. */
  readonly kernel: ReadonlySet<string>;
  /** Names from the decode runtime this module refers to. */
  readonly runtime: ReadonlySet<string>;
  /** Whether this module refers to the saga runtime. */
  readonly saga?: boolean;
  /** For a service: the handler method named for each `reacts`. */
  readonly handlers?: readonly HandlerSymbol[];
}

const doc = (lines: readonly string[]): string[] => ["/**", ...lines.map((l) => ` * ${l}`), " */"];

/**
 * A name this module needs, remembered with the package that exports it.
 *
 * Qualified rather than bare, because two packages may declare the same name — `acme.retail.common`
 * and `acme.shop` both have a `Money` — and a bare name sent a module off to import its own exports
 * from somebody else's module. Which compiles until the two happen to be the same file.
 */
export const needed = (pkg: string, name: string): string => `${pkg}|${name}`;

/** The package and the name back out of one. */
export const splitNeed = (text: string): { pkg: string; name: string } => {
  const at = text.indexOf("|");
  return { pkg: text.slice(0, at), name: text.slice(at + 1) };
};

const KERNEL_NAMES = ["Uuid", "Instant", "Duration", "CivilDate", "Base64Url", "Decimal", "Branded"];

/** Which kernel aliases a rendered type mentions, so the import names only what is used. */
function kernelIn(text: string, into: Set<string>): void {
  for (const name of KERNEL_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(text)) into.add(name);
  }
}

/** The constraints a field states, as one line a reader can see beside it. */
const rulesOf = (field: FieldIr, ctx: Context): string[] =>
  [...field.constraints, ...chainOf(field.type, ctx)].map(sayConstraint);

/**
 * A constraint as the model writes it.
 *
 * The bounds arrive as separate tokens — `["1", "..", "50"]` — so joining on a space would read
 * `size 1 .. 50`, which is not what anybody wrote.
 */
export const sayConstraint = (c: { name: string; args: readonly string[] }): string =>
  `${c.name} ${c.args.includes("..") ? c.args.join("") : c.args.join(", ")}`.trim();

/* ---------------------------------------------------------------------- enum */

/**
 * An enum as a union of string literals.
 *
 * Not a TypeScript `enum`, which is a runtime object with reverse mappings nobody asked for and which
 * does not survive `JSON.stringify` as the member name. A union of literals *is* the canonical
 * encoding — the member name as written (`01-kernel.md` 7.1) — and narrows exhaustively in a `switch`.
 */
function emitEnum(decl: EnumIr): Emitted {
  const name = pascal(decl.id.name);
  const members = decl.members.map((m) => m.name);

  return {
    losses: [],
    problems: [],
    needs: new Set(),
    kernel: new Set(),
    runtime: new Set(),
    lines: [
      ...doc([
        `\`${decl.id.name}\`, as the member names the model declares.`,
        "",
        "A union of string literals rather than a TypeScript `enum`: a union *is* the canonical",
        "encoding, narrows exhaustively in a `switch`, and has no runtime object behind it.",
      ]),
      `export type ${name} = ${members.map(quote).join(" | ")};`,
      "",
      ...doc([`Every member of \`${decl.id.name}\`, in declaration order.`]),
      `export const ${name}Members = [${members.map(quote).join(", ")}] as const;`,
      "",
      ...doc([`Whether a value is a member of \`${decl.id.name}\`.`]),
      `export const is${name} = (value: unknown): value is ${name} =>`,
      `  typeof value === "string" && (${name}Members as readonly string[]).includes(value);`,
    ],
  };
}

/* --------------------------------------------------------------------- value */

/**
 * A nominal value as a branded type and the function that makes one.
 *
 * The brand is why `decode` is the only way in: `"x" as Sku` compiles, and a reader who sees that in a
 * diff knows to ask. `decodeSku` checks what the model said and the brand is the evidence it did.
 */
function emitValue(decl: ValueIr, ctx: Context): Emitted {
  const name = pascal(decl.id.name);
  const kernelBase = tsType(decl.base, ctx, decl.id.name);
  // A wide `int` is carried as text, so the type it brands is `string` and not `number`. Decided by
  // Core's `intIsWide`, which is the same question the guard below asks.
  const wideInt =
    decl.base.t === "kernel" && decl.base.name === "int" && intIsWide({ constraints: decl.constraints });
  const base = wideInt ? { text: "string", problems: kernelBase.problems } : kernelBase;
  const kernel = new Set<string>();
  const losses: Loss[] = [];
  kernelIn(base.text, kernel);

  const rules = decl.constraints.map(sayConstraint);
  const shape = shapeOf(decl.base, ctx, decl.constraints);

  if (ctx.valueTypes === "alias") {
    return {
      lines: [],
      losses: [
        {
          construct: "nominal value",
          at: decl.id.name,
          fidelity: "none",
          detail:
            `\`${decl.id.name}\` is an alias for the type it refines, and TypeScript is structural — ` +
            `so any value of that type is accepted where this one belongs. Its rules travel to each ` +
            `use instead. Set \`valueTypes\` to \`brand\` to keep it nominal.`,
        },
      ],
      problems: [],
      needs: new Set(),
      kernel: new Set(),
      runtime: new Set(),
    };
  }

  kernel.add("Branded");

  const checks: string[] = [];
  const guard = shapeGuard(decl.base, ctx, "value", decl.constraints);
  for (const constraint of decl.constraints) {
    const check = checksFor(constraint, "value", decl.id.name, shape);
    checks.push(...check.lines);
    if (check.loss !== undefined) losses.push(check.loss);
  }

  // A value refining another value is bound by both, and the inner decoder is what says so.
  const inner = declOf(decl.base, ctx);
  const delegate =
    inner?.kind === "value" && ctx.valueTypes === "brand"
      ? `${camelOf(inner.id.name)}Into`
      : undefined;

  return {
    losses,
    problems: base.problems,
    // Named whether or not it is in this package: under `per-declaration` a sibling is still another
    // module, and the grouping drops an import to the module being written.
    needs: new Set(
      delegate === undefined
        ? []
        : [needed(inner!.id.pkg, pascal(inner!.id.name)), needed(inner!.id.pkg, delegate)],
    ),
    kernel,
    // `Decoded` is named here rather than added to every module that imports anything from the
    // runtime: a service module imports the handler shapes and no `Decoded`, and an import nobody
    // uses fails `noUnusedLocals`.
    runtime: new Set(["Decoded", "Problems", ...guard.runtime]),
    lines: [
      ...doc([
        `\`${decl.id.name}\`, a type of its own rather than the \`${base.text}\` it refines.`,
        ...(rules.length === 0 ? [] : ["", `The model constrains it: ${rules.join("; ")}.`]),
        "",
        "Branded, so TypeScript will not accept any other string here — and `decodeX` is the only",
        "way to get one, because a cast would be a claim nobody checked.",
      ]),
      `export type ${name} = Branded<${base.text}, ${quote(decl.id.name)}>;`,
      "",
      ...doc([`Checks a value against what the model says \`${decl.id.name}\` is.`]),
      `export function ${name.charAt(0).toLowerCase()}${name.slice(1)}Into(`,
      "  value: unknown,",
      "  problems: Problems,",
      `): ${name} | undefined {`,
      ...indent([
        // How many problems there were before this value was looked at.
        //
        // `problems.ok` sat here, and `ok` is the *whole walk's* list: one collector is shared so that
        // paths build themselves as the walk descends. So a value decoded only while nothing anywhere
        // had failed yet, and after the first failure every later field came back `undefined` — which
        // skipped its own constraints silently. A payload with a bad list element and a duplicate tag
        // reported the element and not the duplicate, so "which fields are wrong" was answered in
        // part. The decode equivalence harness found it; nothing else could, because the overall
        // decode fails either way and only the problem *list* was short.
        "const before = problems.all.length;",
        ...(guard.wrong === "false"
          ? []
          : [`if (${guard.wrong}) { problems.add(${quote(guard.rule)}); return undefined; }`]),
        ...(delegate === undefined
          ? []
          : [`if (${delegate}(value, problems) === undefined) return undefined;`]),
        ...checks,
        `return problems.all.length === before ? (value as ${name}) : undefined;`,
      ]),
      "}",
      "",
      ...doc([`Decodes a \`${decl.id.name}\` from anything, or says why it is not one.`]),
      `export const decode${name} = (value: unknown): Decoded<${name}> => {`,
      "  const problems = new Problems();",
      `  const decoded = ${name.charAt(0).toLowerCase()}${name.slice(1)}Into(value, problems);`,
      "  return decoded === undefined || !problems.ok",
      "    ? { ok: false, problems: problems.all }",
      "    : { ok: true, value: decoded };",
      "};",
    ],
  };
}

/* -------------------------------------------------------------------- shapes */

interface Guard {
  /** True when the value is *not* the shape its type claims. */
  readonly wrong: string;
  readonly rule: string;
  readonly runtime: readonly string[];
}

/**
 * The check that a value is the shape its type claims.
 *
 * This is the half the C# provider needs none of: there, a `Guid` is a `Guid` because the runtime says
 * so. Here a `Uuid` is a string somebody promised looks like one, and the brand is only honest if
 * something checked.
 *
 * Returned as a condition rather than as statements, because a caller has to be able to write it as an
 * `if`/`else` — stripping a `return` out of a ready-made statement leaves the narrowing behind, and
 * then every check after it runs against `unknown`.
 */
function shapeGuard(
  type: TypeIr,
  ctx: Context,
  value: string,
  /** Everything bounding this value, its own and whatever its type chain brings. */
  constraints: readonly ConstraintIr[] = [],
): Guard {
  const base = throughOf(type, ctx);
  if (base.t !== "kernel") return { wrong: "false", rule: "", runtime: [] };

  const text = (pattern: string, name: string, rule: string): Guard => ({
    wrong: `typeof ${value} !== "string" || !${pattern}.test(${value})`,
    rule,
    runtime: [name],
  });

  /**
   * The same, where the runtime answers with a function rather than a pattern.
   *
   * A regex can say two digits and cannot say "at most twelve", so a date and an instant are checked
   * for their shape *and* their calendar — `2026-02-31` is neither a day that happened nor a thing
   * `DateOnly` will deserialize.
   */
  const asks = (fn: string, rule: string): Guard => ({
    wrong: `typeof ${value} !== "string" || !${fn}(${value})`,
    rule,
    runtime: [fn],
  });

  switch (base.name) {
    case "bool":
      return { wrong: `typeof ${value} !== "boolean"`, rule: "expected a boolean", runtime: [] };

    case "int":
      /**
       * A string where the declared range leaves what a number holds exactly.
       *
       * `01-kernel.md` 7.1, and the decision is 7K Core's `intIsWide` rather than this provider's —
       * four providers each deciding what "can exceed" means is four chances to disagree about a
       * wire format, which is the thing the rule exists to stop.
       *
       * A branded *string* rather than a `bigint`, which was the obvious alternative and is wrong
       * for this provider: everything here rests on a decoded value being canonical JSON under
       * `JSON.stringify` with no serializer, and a `bigint` throws there. The string is what the
       * wire carries anyway, so the brand is the only thing added.
       */
      return intIsWide({ constraints })
        ? {
            wrong: `typeof ${value} !== "string" || !/^-?\\d+$/.test(${value})`,
            rule: "expected an integer as a string, because its range reaches past 2^53",
            runtime: [],
          }
        : {
            wrong: `typeof ${value} !== "number" || !Number.isInteger(${value})`,
            rule: "expected an integer",
            runtime: [],
          };

    case "float":
      return {
        wrong: `typeof ${value} !== "number" || !Number.isFinite(${value})`,
        rule: "expected a number",
        runtime: [],
      };

    case "string":
      return { wrong: `typeof ${value} !== "string"`, rule: "expected a string", runtime: [] };

    case "uuid":
      return text("UUID", "UUID", "expected a uuid");

    case "instant":
      return asks("isInstant", "expected an RFC 3339 UTC instant");

    case "date":
      return asks("isCivilDate", "expected a date");

    case "duration":
      return text("DURATION", "DURATION", "expected a duration, ISO 8601 or a 7K literal");

    case "bytes":
      return text("BASE64URL", "BASE64URL", "expected base64url bytes");

    default: {
      // The scale is the contract: `12.5` is not a `decimal(18,2)` and `"12.50"` is.
      const scale = base.scale ?? 0;
      return {
        wrong: `typeof ${value} !== "string" || !decimalAt(${scale}).test(${value})`,
        rule: `expected a decimal with ${scale} fractional digit${scale === 1 ? "" : "s"}`,
        runtime: ["decimalAt"],
      };
    }
  }
}

/* -------------------------------------------------------------------- record */

/** A field's own decode, into a local of the same name. */
function fieldLines(
  field: FieldIr,
  ctx: Context,
  holder: Decl,
  state: { losses: Loss[]; problems: TypeProblem[]; needs: Set<string>; kernel: Set<string>; runtime: Set<string> },
): string[] {
  const at = `${holder.id.name}.${field.name}`;
  const property = `raw[${quote(field.name)}]`;
  const local = `_${field.name}`;
  const type = tsType(field.type, ctx, at);
  state.problems.push(...type.problems);
  kernelIn(type.text, state.kernel);

  // Through the chain as well: `count: Big` carries its range from the value, not from the field.
  if (intLoss(field, throughOf(field.type, ctx), chainOf(field.type, ctx))) {
    state.losses.push({
      construct: "int",
      at,
      fidelity: "partial",
      detail:
        "Its declared range reaches past 2^53, where a JavaScript `number` stops being exact. A " +
        "`bigint` would be exact and would not survive `JSON.stringify`, so the encoding would break " +
        "to fix a range almost nothing uses.",
    });
  }

  const lines: string[] = [`let ${local}: ${type.text} | undefined;`];
  const body = valueInto(field.type, ctx, property, `here.under(${quote(field.name)})`, at, state, local);

  // The field's *own* constraints, which are not the ones its type declares: `items: [Item] { size
  // 1..50 }` says something about this field that `Item` knows nothing about. They are applied to the
  // decoded value, because a `size` is about the list and a `unique` about its elements — neither is
  // a question you can ask of the raw payload before it has been walked.
  //
  // **And only when the walk dropped nothing.** An element that fails to decode is left out of the
  // decoded collection, so a one-element list with one bad element arrived at `size 1..50` holding
  // none and reported a violation the producer did not commit — a second, derived failure for one
  // cause. 7K Core reports only the element's own problem, because it validates in place and the list
  // it measures is the one that was sent. The decode equivalence harness found this on six payloads
  // at once. Guarding the whole block rather than just `size` is deliberate: comparing a partial list
  // for `unique` is unsound in the same way, and for the same reason.
  const own: string[] = [];
  if (field.constraints.length > 0) {
    // The field's own constraints *and* its type's: `count: Big` is wide because `Big` says so.
    const shape = shapeOf(field.type, ctx, [...field.constraints, ...chainOf(field.type, ctx)]);
    const checks: string[] = [];
    for (const constraint of field.constraints) {
      const check = checksFor(constraint, local, at, shape);
      checks.push(...check.lines);
      if (check.loss !== undefined) state.losses.push(check.loss);
      if (constraint.name === "unique") state.runtime.add("allDistinct");
    }
    if (checks.length > 0) {
      const intact =
        shape === "list"
          ? `${local} !== undefined && Array.isArray(${property}) && ${local}.length === ${property}.length`
          : shape === "map"
            ? `${local} !== undefined && isObject(${property}) && Object.keys(${local}).length === Object.keys(${property}).length`
            : `${local} !== undefined`;
      if (shape === "map") state.runtime.add("isObject");
      own.push(
        `if (${intact}) {`,
        ...indent([`const problems = here.under(${quote(field.name)});`, ...checks]),
        "}",
      );
    }
  }

  if (field.optional) {
    lines.push(
      // Absent is absent and `null` is never input (`01-kernel.md` 7.2) — so a `null` is a problem
      // naming the field rather than an empty value.
      `if (${property} === null) here.under(${quote(field.name)}).add("there is no null in 7K: omit the key instead");`,
      `else if (${property} !== undefined) {`,
      ...indent(body),
      "}",
    );
  } else {
    lines.push(
      `if (${property} === undefined || ${property} === null) {`,
      `  here.under(${quote(field.name)}).add("required");`,
      "} else {",
      ...indent(body),
      "}",
    );
  }

  return [...lines, ...own];
}

/** Whatever it takes to turn one raw value into one typed value, by its shape. */
function valueInto(
  type: TypeIr,
  ctx: Context,
  raw: string,
  problems: string,
  at: string,
  state: { losses: Loss[]; problems: TypeProblem[]; needs: Set<string>; kernel: Set<string>; runtime: Set<string> },
  into: string,
): string[] {
  const decl = declOf(type, ctx);

  // A declared type brings its own decoder, which is where its rules live.
  if (decl !== undefined && (decl.kind === "value" || decl.kind === "record" || decl.kind === "envelope")) {
    if (decl.kind === "value" && ctx.valueTypes === "alias") {
      // No decoder to call, so the rules are inlined — otherwise choosing `alias` would drop them.
      const shape = shapeOf(type, ctx, chainOf(type, ctx));
      const guard = shapeGuard(type, ctx, raw, chainOf(type, ctx));
      for (const name of guard.runtime) state.runtime.add(name);
      const checks: string[] = [];
      for (const constraint of chainOf(type, ctx)) {
        const check = checksFor(constraint, raw, at, shape);
        checks.push(...check.lines);
        if (check.loss !== undefined) state.losses.push(check.loss);
      }
      return scalarInto(guard, checks, problems, raw, into);
    }

    // Named whatever the module it lives in, which under `per-declaration` is a different file even
    // inside one package. The grouping drops an import to the module being written.
    const fn = `${camelOf(decl.id.name)}Into`;
    state.needs.add(needed(decl.id.pkg, fn));
    state.needs.add(needed(decl.id.pkg, pascal(decl.id.name)));
    void ctx;
    return [`${into} = ${fn}(${raw}, ${problems}) ?? undefined;`];
  }

  if (decl?.kind === "enum") {
    state.needs.add(needed(decl.id.pkg, `is${pascal(decl.id.name)}`));
    state.needs.add(needed(decl.id.pkg, pascal(decl.id.name)));
    return [
      `if (!is${pascal(decl.id.name)}(${raw})) ${problems}.add(${quote(`a member of \`${decl.id.name}\``)});`,
      `else ${into} = ${raw};`,
    ];
  }

  if (type.t === "list") {
    const element = valueInto(type.item, ctx, "item", "each", at, state, "decodedItem");
    const itemType = tsType(type.item, ctx, at);
    return [
      `if (!Array.isArray(${raw})) ${problems}.add("expected a list");`,
      "else {",
      ...indent([
        `const out: ${itemType.text}[] = [];`,
        `${raw}.forEach((item: unknown, index: number) => {`,
        ...indent([
          `const each = ${problems}.at(index);`,
          `let decodedItem: ${itemType.text} | undefined;`,
          ...element,
          "if (decodedItem !== undefined) out.push(decodedItem);",
        ]),
        "});",
        `${into} = out;`,
      ]),
      "}",
    ];
  }

  if (type.t === "map") {
    const value = valueInto(type.value, ctx, "entryValue", "each", at, state, "decodedValue");
    const keyType = tsType(type.key, ctx, at);
    const valueType = tsType(type.value, ctx, at);
    const keyInto = valueInto(type.key, ctx, "entryKey", "each", at, state, "decodedKey");
    state.runtime.add("isObject");
    return [
      `if (!isObject(${raw})) ${problems}.add("expected an object");`,
      "else {",
      ...indent([
        `const out: Record<string, ${valueType.text}> = {};`,
        `for (const [entryKey, entryValue] of Object.entries(${raw})) {`,
        ...indent([
          `const each = ${problems}.under(entryKey);`,
          `let decodedKey: ${keyType.text} | undefined;`,
          ...keyInto,
          `let decodedValue: ${valueType.text} | undefined;`,
          ...value,
          "if (decodedKey !== undefined && decodedValue !== undefined) out[decodedKey] = decodedValue;",
        ]),
        "}",
        `${into} = out as typeof ${into};`,
      ]),
      "}",
    ];
  }

  // A kernel scalar: the shape is the whole of the check at this level.
  const guard = shapeGuard(type, ctx, raw, chainOf(type, ctx));
  for (const name of guard.runtime) state.runtime.add(name);
  return scalarInto(guard, [], problems, raw, into);
}

/**
 * A scalar, checked and assigned.
 *
 * The `else` is load bearing: TypeScript narrows `unknown` inside it, so the rules below run against a
 * string the compiler agrees is a string. An early `return` would do the same and is not available
 * here, because this sits inside a walk that has other fields still to decode.
 */
function scalarInto(
  guard: Guard,
  checks: readonly string[],
  problems: string,
  raw: string,
  into: string,
): string[] {
  // Measured locally, not with `problems.ok`: the collector is shared across the whole walk, so `ok`
  // asks whether *anything* has failed. See the longer note on the branded decoder above.
  const body = [...checks, `if (problems.all.length === before) ${into} = ${raw} as typeof ${into};`];
  return [
    "{",
    ...indent([
      `const problems = ${problems};`,
      "const before = problems.all.length;",
      ...(guard.wrong === "false"
        ? body
        : [`if (${guard.wrong}) problems.add(${quote(guard.rule)});`, "else {", ...indent(body), "}"]),
    ]),
    "}",
  ];
}

const camelOf = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** A record, a message or an envelope: a type and the decoder that produces it. */
function emitRecord(decl: RecordIr | MessageIr, ctx: Context): Emitted {
  const name = pascal(decl.id.name);
  const state = {
    losses: [] as Loss[],
    problems: [] as TypeProblem[],
    needs: new Set<string>(),
    kernel: new Set<string>(),
    runtime: new Set<string>(["Decoded", "Problems", "isObject"]),
  };

  const fields = fieldsOf(decl, ctx);
  const properties: string[] = [];

  for (const field of fields) {
    const at = `${decl.id.name}.${field.name}`;
    const type = tsType(field.type, ctx, at);
    state.problems.push(...type.problems);
    kernelIn(type.text, state.kernel);
    const target = declOf(field.type, ctx);
    // An aliased value exports nothing of its own, so there would be nothing to import.
    const aliased = target?.kind === "value" && ctx.valueTypes === "alias";
    if (target !== undefined && !aliased) {
      state.needs.add(needed(target.id.pkg, pascal(target.id.name)));
    }

    const rules = rulesOf(field, ctx);
    if (rules.length > 0 || field.role !== undefined) {
      properties.push(
        ...doc([
          ...(field.role === undefined ? [] : [`\`@role(${field.role})\`.`]),
          ...(rules.length === 0 ? [] : [`The model constrains it: ${rules.join("; ")}.`]),
        ]),
      );
    }
    properties.push(`readonly ${field.name}${field.optional ? "?" : ""}: ${type.text};`);
  }

  const decoding = fields.flatMap((field) => fieldLines(field, ctx, decl, state));
  const assembled = fields
    .map((field) =>
      field.optional
        ? `...(_${field.name} === undefined ? {} : { ${field.name}: _${field.name} }),`
        : `${field.name}: _${field.name},`,
    );

  // An invariant relates fields, so it is checked once they are all in hand.
  const invariants = invariantsOf(decl).flatMap((invariant) => {
    const check = invariantInto(invariant, fields, ctx);
    if (check.text === undefined) {
      state.losses.push({
        construct: "invariant",
        at: decl.id.name,
        fidelity: "none",
        detail: `Not checked here because ${check.why ?? "it is unsupported"}.`,
      });
      return [`// 7K: an invariant is not checked here — ${check.why ?? "unsupported"}.`];
    }
    return [`if (!(${check.text})) here.add(${quote(`invariant ${check.said}`)});`];
  });

  const required = fields.filter((f) => !f.optional).map((f) => `_${f.name} === undefined`);

  return {
    losses: state.losses,
    problems: state.problems,
    needs: state.needs,
    kernel: state.kernel,
    runtime: state.runtime,
    lines: [
      ...doc([
        `\`${qualifiedOf(decl)}\`${decl.kind === "message" && decl.version !== undefined ? `, v${decl.version}` : ""}.`,
        ...(decl.kind === "message"
          ? [
              "",
              decl.intent === "command"
                ? "A command: it instructs, and may be refused."
                : decl.intent === "event"
                  ? "An event: it states something that already happened."
                  : decl.intent === "query"
                    ? "A query: it asks, changes nothing, and carries no deduplication key."
                    : "The model declares no intent for it.",
            ]
          : []),
      ]),
      `export interface ${name} {`,
      ...indent(properties),
      "}",
      "",
      ...doc([
        `Checks an unknown value against what the model says \`${decl.id.name}\` is.`,
        "",
        "Takes a collector so that a nested value reports its path relative to the whole, which is how",
        "`lines[2].unit.currency` comes out of a walk that only ever saw one field at a time.",
      ]),
      `export function ${camelOf(decl.id.name)}Into(`,
      "  value: unknown,",
      "  here: Problems,",
      `): ${name} | undefined {`,
      ...indent([
        `const raw = value;`,
        `if (!isObject(raw)) { here.add("expected an object"); return undefined; }`,
        "",
        ...decoding,
        "",
        ...(required.length === 0 ? [] : [`if (${required.join(" || ")}) return undefined;`]),
        ...(invariants.length === 0
          ? []
          : [`const decoded = {`, ...indent(assembled), `} as ${name};`, ...invariants, ""]),
        ...(invariants.length === 0
          ? [`return { ${assembled.join(" ")} } as ${name};`]
          : ["return here.ok ? decoded : undefined;"]),
      ]),
      "}",
      "",
      ...doc([
        `Decodes a \`${decl.id.name}\` from anything, or says why it is not one.`,
        "",
        "This is the only way into the type. `JSON.parse(body) as " + name + "` compiles and is a",
        "claim nobody checked — a message off a queue is `unknown`, and a TypeScript type is gone by",
        "the time it arrives.",
      ]),
      `export const decode${name} = (value: unknown): Decoded<${name}> => {`,
      "  const problems = new Problems();",
      `  const decoded = ${camelOf(decl.id.name)}Into(value, problems);`,
      "  return decoded === undefined || !problems.ok",
      "    ? { ok: false, problems: problems.all }",
      "    : { ok: true, value: decoded };",
      "};",
    ],
  };
}

const qualifiedOf = (decl: Decl): string =>
  decl.id.pkg === "" ? decl.id.name : `${decl.id.pkg}.${decl.id.name}`;

/* ---------------------------------------------------------------- invariants */

/**
 * An invariant over the fields in hand.
 *
 * Deliberately a subset: comparisons between paths and literals, combined with and/or/not, with a list
 * projection on at most one side. Two projections in one comparison have no single agreed meaning, and
 * guessing would be worse than saying so.
 */
function invariantInto(
  predicate: Predicate,
  fields: readonly FieldIr[],
  ctx: Context,
): { text?: string; why?: string; said: string } {
  const said = describePredicate(predicate);

  switch (predicate.p) {
    case "and":
    case "or": {
      const parts = predicate.operands.map((p) => invariantInto(p, fields, ctx));
      const failed = parts.find((p) => p.text === undefined);
      if (failed !== undefined) return { said, ...(failed.why === undefined ? {} : { why: failed.why }) };
      return { said, text: `(${parts.map((p) => p.text).join(predicate.p === "and" ? " && " : " || ")})` };
    }

    case "not": {
      const inner = invariantInto(predicate.operand, fields, ctx);
      return inner.text === undefined ? { ...inner, said } : { said, text: `!(${inner.text})` };
    }

    case "cmp": {
      const OPS: Readonly<Record<string, string>> = {
        "==": "===",
        "!=": "!==",
        "<": "<",
        "<=": "<=",
        ">": ">",
        ">=": ">=",
      };
      const op = OPS[predicate.op];
      if (op === undefined) return { said, why: `the operator \`${predicate.op}\` is not expressed here` };

      const path = (operand: typeof predicate.left): readonly string[] | undefined =>
        operand.k === "field" || operand.k === "message" ? operand.path : undefined;

      const left = path(predicate.left);
      const right = path(predicate.right);
      const projects = (p: readonly string[] | undefined): boolean => p !== undefined && p.includes("[]");

      if (predicate.left.k === "envelope" || predicate.right.k === "envelope") {
        return { said, why: "it reads the envelope, which does not travel with the body" };
      }
      if ((left === undefined && predicate.left.k !== "literal") || (right === undefined && predicate.right.k !== "literal")) {
        return { said, why: "it reads something outside the message" };
      }
      if (projects(left) && projects(right)) {
        return { said, why: "it projects over two lists at once, which has no single meaning" };
      }

      const render = (operand: typeof predicate.left, p: readonly string[] | undefined): string =>
        operand.k === "literal"
          ? JSON.stringify(operand.value)
          : `decoded${(p ?? []).filter((s) => s !== "[]").map((s) => `.${s}`).join("")}`;

      if (!projects(left) && !projects(right)) {
        return { said, text: `${render(predicate.left, left)} ${op} ${render(predicate.right, right)}` };
      }

      const list = projects(left) ? left! : right!;
      const at = list.indexOf("[]");
      const element = `e${list.slice(at + 1).map((s) => `.${s}`).join("")}`;
      const other = projects(left)
        ? render(predicate.right, right)
        : render(predicate.left, left);
      const [a, b] = projects(left) ? [element, other] : [other, element];
      void ctx;
      void fields;
      return {
        said,
        text: `decoded${list.slice(0, at).map((s) => `.${s}`).join("")}.every((e) => ${a} ${op} ${b})`,
      };
    }

    default:
      return { said, why: "7K could not parse it" };
  }
}

/** An invariant as the model would have written it, for the problem a caller reads. */
export function describePredicate(predicate: Predicate): string {
  switch (predicate.p) {
    case "and":
    case "or":
      return predicate.operands.map(describePredicate).join(predicate.p === "and" ? " and " : " or ");
    case "not":
      return `not ${describePredicate(predicate.operand)}`;
    case "cmp": {
      const side = (operand: { k: string; [k: string]: unknown }): string => {
        if (operand.k === "literal") return JSON.stringify(operand["value"]);
        if (operand.k === "claim") return `claim.${String(operand["name"])}`;
        const path = (operand["path"] as readonly string[] | undefined) ?? [];
        const text = path.join(".").replace(/\.\[\]/g, "[]");
        return operand.k === "envelope" ? `envelope.${text}` : text;
      };
      return `${side(predicate.left)} ${predicate.op} ${side(predicate.right)}`;
    }
    default:
      return predicate.text;
  }
}

/** Everything one declaration becomes. */
export function emitDecl(decl: Decl, ctx: Context): Emitted | undefined {
  switch (decl.kind) {
    case "enum":
      return emitEnum(decl);
    case "value":
      return emitValue(decl, ctx);
    case "record":
    case "envelope":
    case "message":
      return emitRecord(decl, ctx);
    default:
      return undefined;
  }
}
