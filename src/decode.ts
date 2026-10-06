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
import { flatFieldsOf } from "@sevenk/core";
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
  "export const INSTANT = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$/;",
  "export const CIVIL_DATE = /^\\d{4}-\\d{2}-\\d{2}$/;",
  "export const BASE64URL = /^[A-Za-z0-9_-]*$/;",
  "export const DURATION = /^-?P(?!$)(\\d+(\\.\\d+)?[DW])?(T(?!$)(\\d+(\\.\\d+)?[HMS])+)?$/;",
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
  shape: "string" | "number" | "list" | "map" | "other",
): Check {
  const b = bounds(constraint.args);
  const rule = (name: string): string =>
    b.exact !== undefined ? `${name} ${b.exact}` : `${name} ${b.low ?? ""}..${b.high ?? ""}`;

  const guard = (condition: string, text: string): string =>
    `if (${condition}) problems.add(${quote(text)});`;

  switch (constraint.name) {
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
      // A decimal is a string, so its range is compared numerically rather than lexically: `"9"` is
      // greater than `"10"` as text and is not as a number.
      const n = shape === "number" ? value : `Number(${value})`;
      const parts: string[] = [];
      if (b.exact !== undefined) parts.push(`${n} !== ${b.exact}`);
      if (b.low !== undefined) parts.push(`${n} < ${b.low}`);
      if (b.high !== undefined) parts.push(`${n} > ${b.high}`);
      return { lines: parts.length === 0 ? [] : [guard(parts.join(" || "), rule("range"))] };
    }

    case "multipleOf": {
      const by = constraint.args[0] ?? "1";
      const n = shape === "number" ? value : `Number(${value})`;
      return { lines: [guard(`${n} % ${by} !== 0`, `multipleOf ${by}`)] };
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

/** What shape a value has at runtime, which decides how it is checked and counted. */
export function shapeOf(type: TypeIr, ctx: Context): "string" | "number" | "list" | "map" | "other" {
  if (type.t === "list") return "list";
  if (type.t === "map") return "map";
  if (type.t === "kernel") {
    if (type.name === "int" || type.name === "float") return "number";
    if (type.name === "bool") return "other";
    // Everything else the kernel has is a string on the wire, decimals included.
    return "string";
  }
  if (type.t === "ref") {
    const decl = declOf(type, ctx);
    if (decl?.kind === "value") return shapeOf(decl.base, ctx);
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
