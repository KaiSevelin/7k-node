/**
 * A decoder from `unknown`, which is what a message actually is.
 *
 * In C# the generated validator is a convenience: the type system already got the shape right and the
 * validator adds the rules the type cannot carry. Here it is the whole of the checking — a payload off
 * a queue is `unknown`, `as PlaceOrder` is a lie the compiler will believe, and nothing else between
 * the wire and the code knows what the model said.
 *
 * So this generates a **decoder** and not a validator: it takes `unknown` and returns either the typed
 * value or the problems, which is the only shape that makes the type claim true. A function returning
 * `boolean` would leave the caller to assert, and an assertion is where the guarantee leaks.
 *
 * **It checks the encoding as well as the rules.** A `uuid` has to look like one, a `decimal(18,2)` has
 * to be a string with two fractional digits, an `instant` has to be RFC 3339 UTC — because the branded
 * types claim exactly that, and a decoder that returned `"nonsense" as Uuid` would make every type
 * downstream a guess. That check does not exist in the C# provider, where the runtime types enforce it.
 *
 * **An absent optional field is absent, and `null` is never valid input** (`01-kernel.md` 7.2). There is
 * no null in 7K, so a `null` is a problem naming the field rather than an empty value.
 */

import type { ConstraintIr, Decl, FieldIr, Predicate, TypeIr } from "@sevenk/core";
import { flatFieldsOf, intIsWide } from "@sevenk/core";
import { declOf, pascal, type Context, type TypeProblem } from "./types.js";

export interface Decoder {
  readonly lines: readonly string[];
  readonly needsKernel: boolean;
  readonly problems: readonly TypeProblem[];
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `  ${l}`));

const quote = (text: string): string => JSON.stringify(text);

/** A constraint's bounds, from the raw tokens the parser kept: `["1", "..", "200"]`. */
export function bounds(args: readonly string[]): { low?: string; high?: string; exact?: string } {
  const at = args.indexOf("..");
  if (at < 0) return args[0] === undefined ? {} : { exact: args[0] };
  const low = args.slice(0, at).join("");
  const high = args.slice(at + 1).join("");
  return { ...(low === "" ? {} : { low }), ...(high === "" ? {} : { high }) };
}

/** A regex literal as the parser kept it: `/^[A-Z]{3}$/`. */
const regexBody = (literal: string): string => {
  const close = literal.lastIndexOf("/");
  return literal.startsWith("/") && close > 0 ? literal.slice(1, close) : literal;
};

const fieldsOf = (decl: Decl, ctx: Context): readonly FieldIr[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? flatFieldsOf(ctx.model, decl)
    : [];

const invariantsOf = (decl: Decl): readonly Predicate[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? decl.invariants
    : [];

/* ------------------------------------------------------------------- support */

/**
 * The runtime every generated decoder shares.
 *
 * `Decoded<T>` is a result and not an exception, because a message that fails to decode is an ordinary
 * outcome a handler has to report — 7K's own trace has a `reason` of `invalid` for it — and throwing
 * would make the common case a stack unwind. The problems carry a path, so a service can answer "which
 * field" without anybody parsing a message.
 */
export const RUNTIME = [
  "/**",
  " * What a decoder gives back.",
  " *",
  " * A result and not an exception: a payload that does not satisfy the contract is an ordinary",
  " * outcome — 7K's trace has a `reason` of `invalid` for exactly it — and throwing would make the",
  " * common case a stack unwind. The problems carry a path, so a service can say *which* field.",
  " */",
  "export type Decoded<T> =",
  "  | { readonly ok: true; readonly value: T }",
  "  | { readonly ok: false; readonly problems: readonly Problem[] };",
  "",
  "/** A rule the payload does not satisfy, and where. */",
  "export interface Problem {",
  "  /** The field, as the model names it: `lines[2].unit.currency`. Empty for the whole value. */",
  "  readonly path: string;",
  "  /** The rule, as the model states it. */",
  "  readonly rule: string;",
  "}",
  "",
  "/** Collects problems as a decoder walks a payload, building the path as it descends. */",
  "export class Problems {",
  "  readonly all: Problem[] = [];",
  "",
  "  constructor(private readonly path: string = \"\") {}",
  "",
  "  /** A collector for a field of this one, so a path builds itself as the walk descends. */",
  "  under(step: string): Problems {",
  "    const nested = new Problems(this.path === \"\" ? step : `${this.path}.${step}`);",
  "    // Shares the list rather than copying: one walk, one set of problems, in the order found.",
  "    Object.defineProperty(nested, \"all\", { value: this.all });",
  "    return nested;",
  "  }",
  "",
  "  /** A collector for an element, which is addressed by position. */",
  "  at(index: number): Problems {",
  "    const nested = new Problems(`${this.path}[${index}]`);",
  "    Object.defineProperty(nested, \"all\", { value: this.all });",
  "    return nested;",
  "  }",
  "",
  "  add(rule: string): void {",
  "    this.all.push({ path: this.path, rule });",
  "  }",
  "",
  "  get ok(): boolean {",
  "    return this.all.length === 0;",
  "  }",
  "}",
  "",
  "/** Whether a value is a JSON object, which is the only thing a record can decode from. */",
  "export const isObject = (value: unknown): value is Record<string, unknown> =>",
  "  typeof value === \"object\" && value !== null && !Array.isArray(value);",
  "",
  "/** The canonical forms the branded kernel types claim.",
  " *",
  " * Checked rather than assumed. A decoder that returned `\"nonsense\"` as a `Uuid` would make every",
  " * type downstream a guess, and the brand exists precisely to say it is not.",
  " */",
  "export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;",
  "const INSTANT = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,6})?Z$/;",
  "const CIVIL_DATE = /^(\\d{4})-(\\d{2})-(\\d{2})$/;",
  "",
  "/**",
  " * Whether a date of the right shape is also a day that happened.",
  " *",
  " * A regex can say two digits and cannot say \"at most twelve\", so the shape check alone took",
  " * `2026-13-01`, `2026-02-31` and `2026-01-01T25:00:00Z`. `01-kernel.md` calls one a civil date",
  " * and the other RFC 3339, and neither is a string that only looks like one.",
  " *",
  " * The same calendar 7K Core applies. The two are held to it by the decoding equivalence harness",
  " * rather than by having been written together, which is the only thing that keeps two",
  " * implementations of one rule honest. Leap seconds are refused, as .NET refuses them, so all",
  " * three implementations agree about what a moment is.",
  " */",
  "const leapYear = (year: number): boolean =>",
  "  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;",
  "",
  "const daysIn = (year: number, month: number): number =>",
  "  month === 2",
  "    ? leapYear(year)",
  "      ? 29",
  "      : 28",
  "    : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;",
  "",
  "const civilDate = (year: number, month: number, day: number): boolean =>",
  "  month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);",
  "",
  "export const isInstant = (value: string): boolean => {",
  "  const m = INSTANT.exec(value);",
  "  if (m === null) return false;",
  "  if (!civilDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;",
  "  return Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 59;",
  "};",
  "",
  "export const isCivilDate = (value: string): boolean => {",
  "  const m = CIVIL_DATE.exec(value);",
  "  return m !== null && civilDate(Number(m[1]), Number(m[2]), Number(m[3]));",
  "};",
  "export const BASE64URL = /^[A-Za-z0-9_-]*$/;",
  "/**",
  " * ISO 8601, or a 7K duration literal.",
  " *",
  " * Both, because `01-kernel.md` section 7 says both: \"ISO 8601 on output (`PT30S`); 7K duration",
  " * literals (`30s`, `1h30m`) accepted on input\". This took only the first, so a generated decoder",
  " * refused every payload whose producer wrote a duration the way the language writes one — which is",
  " * the way a scenario writes one, and the way 7K Core accepts. `ms` comes before `s` in the",
  " * alternation, or `30ms` matches as thirty seconds with a stray `s` after it.",
  " */",
  "export const DURATION =",
  "  /^(?:-?P(?!$)(?:\\d+(?:\\.\\d+)?[DW])?(?:T(?!$)(?:\\d+(?:\\.\\d+)?[HMS])+)?|(?:\\d+(?:ms|s|m|h|d))+)$/;",
  "",
  "/** A decimal with exactly the declared scale, which is what the contract says it is. */",
  "export const decimalAt = (scale: number): RegExp =>",
  "  new RegExp(scale === 0 ? `^-?\\\\d+$` : `^-?\\\\d+\\\\.\\\\d{${scale}}$`);",
  "",
  "/** Whether every element of a list is distinct, by its canonical JSON. */",
  "export const allDistinct = (items: readonly unknown[]): boolean => {",
  "  const seen = new Set<string>();",
  "  for (const item of items) {",
  "    const key = JSON.stringify(item);",
  "    if (seen.has(key)) return false;",
  "    seen.add(key);",
  "  }",
  "  return true;",
  "};",
  "",
  "/**",
  " * What a 7K Sandbox scenario hands a live handler, and what it takes back.",
  " *",
  " * Declared here rather than imported, and that is the point: TypeScript is structural, so a",
  " * function written against these *is* the sandbox's `Handler` without this package depending on",
  " * it. A nominal type system would need the real one in scope — which is why the C# provider has to",
  " * generate its own frame types and gets no such guarantee from doing so.",
  " *",
  " * Narrower than what the sandbox actually passes, deliberately. A message also carries who sent",
  " * it, its claims and the time, and a handler able to read those could branch on something the",
  " * model does not say. A function taking less is assignable where one taking more is wanted, so",
  " * narrowing here costs nothing and forbids something.",
  " */",
  "export type SevenKJson =",
  "  | string",
  "  | number",
  "  | boolean",
  "  | null",
  "  | readonly SevenKJson[]",
  "  | { readonly [key: string]: SevenKJson };",
  "",
  "export interface SevenKMessage {",
  "  readonly envelope: {",
  "    readonly type: string;",
  "    readonly version?: string | undefined;",
  "    /** The declared envelope records, flattened as the language flattens them (D50). */",
  "    readonly fields: Readonly<Record<string, unknown>>;",
  "  };",
  "  /** `unknown`, because that is what a payload is until a decoder says otherwise. */",
  "  readonly body: Readonly<Record<string, unknown>>;",
  "}",
  "",
  "/** One of the subscription's declared replies, or nothing where the model declares none. */",
  "export interface SevenKReply {",
  "  readonly reply?: string;",
  "  readonly body?: Readonly<Record<string, SevenKJson>>;",
  "}",
  "",
  "export type SevenKHandler = (message: SevenKMessage) => Promise<SevenKReply | void>;",
  "",
  "/**",
  " * The decoded value, or a thrown explanation of why the payload was not one.",
  " *",
  " * Thrown rather than returned, because a runtime already reads a handler failure that way: the",
  " * sandbox catches it and retries under the subscription's own policy. And it is worth throwing",
  " * loudly — whatever delivered this validated it against the same model first, so a decoder",
  " * refusing it means the two disagree about the contract. That is a defect in one of them rather",
  " * than a bad message, and the only place it can be noticed is here.",
  " */",
  "export const sevenKDecoded = <T>(what: string, decoded: Decoded<T>): T => {",
  "  if (decoded.ok) return decoded.value;",
  "  const why = decoded.problems",
  "    .map((p) => `${p.path === \"\" ? \"(root)\" : p.path}: ${p.rule}`)",
  "    .join(\"; \");",
  "  throw new Error(",
  "    `7K: a ${what} was delivered as valid and did not decode, so whatever sent it and this ` +",
  "      `decoder disagree about the contract: ${why}`,",
  "  );",
  "};",
  "",
  "/**",
  " * A decoded message, as a reply body.",
  " *",
  " * One cast, here rather than at every call site, and TypeScript's rule behind it is about the",
  " * declaration rather than the value: a generated type is an `interface`, and an interface has no",
  " * implicit index signature however JSON-shaped its fields are. The value came out of a decoder, so",
  " * it is exactly the canonical JSON the contract describes — every brand is a string and nothing",
  " * else is in there.",
  " */",
  "export const sevenKBody = (message: object): Readonly<Record<string, SevenKJson>> =>",
  "  message as Readonly<Record<string, SevenKJson>>;",
].join("\n").split("\n");

export const RUNTIME_MODULE = "decode";

/* -------------------------------------------------------------------- checks */

interface Check {
  readonly lines: readonly string[];
  readonly loss?: { construct: string; at: string; fidelity: "none"; detail: string };
}

/**
 * The checks one constraint becomes, against an expression already known to be the right shape.
 *
 * `normalize` produces none and that is not a gap: it transforms a value rather than rejecting one, so
 * a decoder has nothing to check — and the loss says what accepting an unnormalised value costs.
 */
function checksFor(
  constraint: ConstraintIr,
  value: string,
  at: string,
  shape: Shape,
): Check {
  const b = bounds(constraint.args);
  const rule = (name: string): string =>
    b.exact !== undefined ? `${name} ${b.exact}` : `${name} ${b.low ?? ""}..${b.high ?? ""}`;

  const guard = (condition: string, text: string): string =>
    `if (${condition}) problems.add(${quote(text)});`;

  // Lowercased, because that is what the IR carries: a constraint's name comes from its keyword, and
  // the keywords are lowercase (`multipleof`, not `multipleOf`). A `case "multipleOf"` sat here and
  // never matched, so every `multipleOf` in every model fell through to the loss below — which then
  // reported, untruthfully, that this provider cannot express it. The C# provider had the identical
  // bug, written independently, which says the trap is the IR's lowercase name and not one author's
  // carelessness. The decode equivalence harness found both.
  switch (constraint.name.toLowerCase()) {
    case "length": {
      // On a string this counts characters; on a list it counts elements, exactly as `size` does.
      const of = shape === "list" ? `${value}.length` : `${value}.length`;
      if (b.exact !== undefined) {
        return { lines: [guard(`${of} !== ${b.exact}`, rule("length"))] };
      }
      const parts: string[] = [];
      if (b.low !== undefined) parts.push(`${of} < ${b.low}`);
      if (b.high !== undefined) parts.push(`${of} > ${b.high}`);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), rule("length"))] };
    }

    case "size": {
      const of = shape === "map" ? `Object.keys(${value}).length` : `${value}.length`;
      const parts: string[] = [];
      if (b.low !== undefined) parts.push(`${of} < ${b.low}`);
      if (b.high !== undefined) parts.push(`${of} > ${b.high}`);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), rule("size"))] };
    }

    case "range": {
      // Three ways, because three things are being compared. A number compares as itself. A decimal
      // is a string and compares numerically rather than lexically — `"9"` is greater than `"10"` as
      // text. And a wide int is a string whose whole reason for being one is that `Number` would
      // round it, so it compares as a `bigint`; the bounds are written `10n` for the same reason.
      const big = shape === "wideint";
      const n = shape === "number" ? value : big ? `BigInt(${value})` : `Number(${value})`;
      const lit = (x: string | number): string => (big ? `${x}n` : `${x}`);
      const parts: string[] = [];
      if (b.exact !== undefined) parts.push(`${n} !== ${lit(b.exact)}`);
      if (b.low !== undefined) parts.push(`${n} < ${lit(b.low)}`);
      if (b.high !== undefined) parts.push(`${n} > ${lit(b.high)}`);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), rule("range"))] };
    }

    case "multipleof": {
      const by = constraint.args[0] ?? "1";
      const big = shape === "wideint";
      const n = shape === "number" ? value : big ? `BigInt(${value})` : `Number(${value})`;
      return { lines: [guard(`${n} % ${big ? `${by}n` : by} !== 0`, `multipleOf ${by}`)] };
    }

    case "pattern": {
      const source = constraint.args[0] ?? "";
      return {
        lines: [
          guard(`!new RegExp(${quote(regexBody(source))}).test(${value})`, `pattern ${source}`),
        ],
      };
    }

    case "unique":
      return shape === "list"
        ? { lines: [guard(`!allDistinct(${value})`, "unique")] }
        : { lines: [] };

    case "normalize":
      return {
        lines: [],
        loss: {
          construct: "normalize",
          at,
          fidelity: "none",
          detail:
            `\`normalize ${constraint.args.join(", ")}\` transforms a value and a decoder only ` +
            `accepts or rejects one, so an unnormalised value decodes here where 7K would have ` +
            `rewritten it. Normalise before sending, or compare normalised.`,
        },
      };

    case "example":
      return { lines: [] };

    default:
      return {
        lines: [`// 7K: \`${constraint.name}\` on ${at} is not checked here.`],
        loss: {
          construct: constraint.name,
          at,
          fidelity: "none",
          detail: `This provider does not express \`${constraint.name}\`.`,
        },
      };
  }
}

export type Shape = "string" | "number" | "wideint" | "list" | "map" | "other";

/**
 * What shape a value has at runtime, which decides how it is checked and counted.
 *
 * `wideint` is a string that carries an integer: an `int` whose declared range reaches past what a
 * JSON number holds exactly travels as text (`01-kernel.md` 7.1). It is its own shape and not
 * `string`, because the rules on it are arithmetic — comparing `"9"` with `"10"` as text gets the
 * wrong answer, and comparing them through `Number` gets the right answer for the wrong reason until
 * the day the value is large enough to matter, which for this type is the only day that counts.
 *
 * The constraints come in because the answer depends on them, which is unusual for a shape and is
 * what the rule asks for: the encoding is per field, decided from the model.
 */
export function shapeOf(
  type: TypeIr,
  ctx: Context,
  constraints: readonly ConstraintIr[] = [],
): Shape {
  if (type.t === "list") return "list";
  if (type.t === "map") return "map";
  if (type.t === "kernel") {
    if (type.name === "int") return intIsWide({ constraints }) ? "wideint" : "number";
    if (type.name === "float") return "number";
    if (type.name === "bool") return "other";
    // Everything else the kernel has is a string on the wire, decimals included.
    return "string";
  }
  if (type.t === "ref") {
    const decl = declOf(type, ctx);
    // A value's own constraints are what bound it, so they replace rather than join the caller's.
    if (decl?.kind === "value") return shapeOf(decl.base, ctx, decl.constraints);
    if (decl?.kind === "enum") return "string";
  }
  return "other";
}

/** Every constraint along a chain of nominal values, nearest first. */
export function chainOf(type: TypeIr, ctx: Context): ConstraintIr[] {
  const all: ConstraintIr[] = [];
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref") break;
    const decl = declOf(current, ctx);
    if (decl === undefined || decl.kind !== "value") break;
    all.push(...decl.constraints);
    current = decl.base;
  }
  return all;
}

/** Through a chain of nominal values, to the kernel type underneath. */
export function throughOf(type: TypeIr, ctx: Context): TypeIr {
  let current = type;
  for (let hop = 0; hop < 16; hop++) {
    if (current.t !== "ref") return current;
    const decl = declOf(current, ctx);
    if (decl === undefined || decl.kind !== "value") return current;
    current = decl.base;
  }
  return current;
}

export { checksFor, fieldsOf, invariantsOf, quote, indent };
