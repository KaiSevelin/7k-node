/**
 * Services, as interfaces and nothing more.
 *
 * **7K describes a service's interface, never its internals** (`03-topology.md` 2.0). So this generates
 * the shape a handler must have, every constraint the model places on it as a comment where somebody
 * will read it, and a `TODO` saying what the model cannot say. No body, because there is nothing in the
 * model to generate one from.
 *
 * **Three things the model declares that deliberately become comments**, because they belong to the
 * infrastructure a service runs on and not to the service: delivery (whose demand on the *body* is
 * idempotency, which is said loudly and not implemented), deduplication (the model names the key and
 * the broker holds it) and retry, concurrency and dead-lettering (policy applied around the handler).
 *
 * **What does become code is the outcome, and here it is easy.** `replies A | B` is a sum type, and
 * TypeScript has those — so a discriminated union says it directly, narrows in a `switch`, and an
 * `assertNever` on the default turns a reply added to the model into a compile error at every call
 * site. The C# provider needs a closed class hierarchy and a `Match` method to get the same guarantee,
 * because `switch` over a hierarchy is not exhaustiveness-checked there.
 */

import type { Decl, EmitIr, LinkedModel, ReactIr, Ref, ServiceIr } from "@sevenk/core";
import type { Loss } from "@sevenk/provider";
import { adapterFor, reachable, runtimeFor, unreachable, type Dispatch } from "./devhost.js";
import { describePredicate } from "./emit.js";
import { camel, pascal, qualified, type Context } from "./types.js";

/**
 * Where each handler landed, for a tool that wants to point at it rather than read it.
 *
 * The model says `reacts PlaceOrder from inbound`, so anyone can see which service handles it; nobody
 * but this provider knows the method is `handlePlaceOrder`, because that name is its own convention
 * applied to the model. Recorded from the same call that names it in the interface, so the symbol
 * reported and the symbol written cannot drift.
 */
export interface HandlerSymbol {
  /** The message handled, qualified in the model's terms. */
  readonly message: string;
  /** The method, as TypeScript spells it: `handlePlaceOrder`. */
  readonly method: string;
  /** The interface that declares it, for context: `Desk`. */
  readonly declaredBy: string;
}

export interface Handlers {
  readonly lines: readonly string[];
  readonly losses: readonly Loss[];
  /** Type names this module refers to, qualified by package. */
  readonly needs: ReadonlySet<string>;
  /** Names from the decode runtime, which only the development host brings here. */
  readonly runtime: ReadonlySet<string>;
  /** One per `reacts`, in the order the interface declares them. */
  readonly handlers: readonly HandlerSymbol[];
}

/**
 * What the caller has to tell this about the dev host, because it is not in the model.
 *
 * `decodes` is asked per declaration rather than read once: `decoders` is a declaration-scope option,
 * so a rule may switch it off for one message while leaving it on for the service that reacts to it —
 * and a dispatcher calling a decoder that was never generated is a generated module that does not
 * compile.
 */
export interface Host {
  readonly devHost: boolean;
  readonly decodes: (decl: Decl) => boolean;
}

const indent = (lines: readonly string[]): string[] => lines.map((l) => (l === "" ? "" : `  ${l}`));

const need = (pkg: string, name: string): string => `${pkg}|${name}`;

/** Wraps prose so a comment stays readable in a narrow pane. */
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

/** `v1.0`, `v1.x`, `v1.2..v2.4`, `v1.2+` — as the model writes them. */
function acceptsText(accepts: ReactIr["accepts"]): string {
  if (accepts === undefined) return "every version";
  switch (accepts.k) {
    case "exact":
      return `exactly v${accepts.at.major}.${accepts.at.minor}`;
    case "major":
      return `any minor of v${accepts.major}`;
    case "range":
      return `v${accepts.from.major}.${accepts.from.minor} to v${accepts.to.major}.${accepts.to.minor}`;
    default:
      return `v${accepts.at.major}.${accepts.at.minor} and later`;
  }
}

const seconds = (ms: number): string =>
  ms % 3600000 === 0 && ms >= 3600000
    ? `${ms / 3600000}h`
    : ms % 60000 === 0 && ms >= 60000
      ? `${ms / 60000}m`
      : ms % 1000 === 0
        ? `${ms / 1000}s`
        : `${ms}ms`;

/**
 * Everything the model says about one subscription, as paragraphs.
 *
 * Long, and meant to be: this is the only place a reader sees the whole contract at once, and the
 * alternative is reading the `.7k` file in another window while writing the handler.
 */
function contract(react: ReactIr, model: LinkedModel): string[] {
  const out: string[] = [];
  const pipe = model.declFor(react.pipe);
  const message = model.declFor(react.message);

  if (pipe !== undefined && pipe.kind === "pipe") {
    out.push(
      `Arrives on the ${pipe.pipeKind} \`${qualified(pipe)}\`, which the model declares ` +
        `\`${pipe.delivery}\`${pipe.durable ? " and durable" : " and not durable"}. ` +
        `Accepts ${acceptsText(react.accepts)}.`,
    );

    if (pipe.delivery !== "at-most-once") {
      out.push(
        `**This handler must be idempotent.** \`${pipe.delivery}\` means the same message may arrive ` +
          `more than once, and handling it twice must have the same effect as handling it once ` +
          `(\`01-kernel.md\` 1.5). The transport does not provide that; the body does.`,
      );
    } else {
      out.push(
        `\`at-most-once\` means a message may never arrive at all. Nothing here will tell you one was ` +
          `lost, so this must not be the only path by which something important happens.`,
      );
    }

    out.push(
      pipe.orderingBy === undefined
        ? "Unordered: two messages may be handled in either order, or at the same time."
        : `Ordered by \`${pipe.orderingBy}\`: messages sharing that value arrive in the order sent.`,
    );

    if (pipe.dlq === null) {
      out.push("`dlq none`: a message this handler keeps failing is discarded. Nothing holds it for you.");
    } else if (pipe.dlq !== undefined) {
      const dead = model.declFor(pipe.dlq);
      if (dead !== undefined) out.push(`Exhausted retries go to \`${qualified(dead)}\`.`);
    } else {
      out.push(`Exhausted retries go to the implicit \`${qualified(pipe)}.dead\`.`);
    }
  }

  if (react.dedupe === undefined) {
    const key =
      message !== undefined && (message.kind === "message" || message.kind === "record")
        ? message.fields.find((f) => f.role === "businessKey")?.name
        : undefined;
    if (key !== undefined) {
      out.push(
        `Deduplicated by \`${key}\`, the message's \`@role(businessKey)\`. The infrastructure keeps ` +
          `those keys; this handler does not have to.`,
      );
    }
  } else if ("by" in react.dedupe) {
    out.push(
      `Deduplicated by \`${react.dedupe.by}\`, which the subscription names with \`once per\`. The ` +
        `infrastructure keeps those keys; this handler does not have to.`,
    );
  } else {
    out.push(
      "`once per none`: the model claims this handler is idempotent by construction, so nothing " +
        "deduplicates for it. That claim is about the code below.",
    );
  }

  if (react.where !== undefined) {
    out.push(
      `Filtered: only messages where \`${describePredicate(react.where)}\` are delivered here. The ` +
        `others go elsewhere or nowhere, and this handler never sees them.`,
    );
  }

  if (react.requires !== undefined) {
    out.push(
      `Authorized before it arrives: \`${describePredicate(react.requires)}\` has been checked. This ` +
        `handler may assume it and must not re-decide it — a second, different check is how two ` +
        `answers to one question get shipped.`,
    );
  }

  if (react.concurrency !== undefined) out.push(`At most ${react.concurrency} of these run at a time.`);

  if (react.retry !== undefined) {
    const { retries, delayMs, backoff, maxMs } = react.retry;
    out.push(
      retries === 0
        ? "No retries: a failure here is final, and goes straight to the dead letter."
        : `Retried ${retries} times on failure, first after ${seconds(delayMs)}, ${backoff}` +
            `${maxMs === undefined ? "" : ` up to ${seconds(maxMs)}`}. Rejecting is how you ask for a ` +
            `retry; resolving is how you say it is done.`,
    );
  }

  if (react.issues !== undefined && react.issues.length > 0) {
    const names = react.issues
      .map((ref) => model.declFor(ref))
      .filter((d): d is Decl => d !== undefined)
      .map((d) => `\`${qualified(d)}\``);
    out.push(
      `While handling this, the model says it sends ${names.join(", ")} onward. Nobody awaits those, ` +
        `so they are published through the outbound port rather than returned.`,
    );
  }

  if (react.replies === undefined) {
    out.push(
      "The model does not say what this replies, so neither does this signature. 7K reports that as " +
        "`incomplete`; until it is declared, nothing can know what this handler owes its caller.",
    );
  }

  return out;
}

/** The method name: the message, and the subscription too where the modeller named one. */
function methodName(react: ReactIr, service: ServiceIr, model: LinkedModel): string {
  const message = model.declFor(react.message);
  const base = pascal(message?.id.name ?? react.message.text);
  // `subscription` defaults to the service's own name; anything else is a name the modeller chose.
  return react.subscription === service.id.name
    ? `handle${base}`
    : `handle${base}As${pascal(react.subscription)}`;
}

const repliesOf = (react: ReactIr, model: LinkedModel): Decl[] =>
  (react.replies ?? [])
    .filter((r): r is Ref => r !== "none")
    .map((ref) => model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);

/**
 * A closed set of outcomes, as a discriminated union.
 *
 * Which is all TypeScript needs: a `switch` on `kind` narrows, and `assertNever` on the default makes a
 * reply added to the model a compile error at every call site. The C# provider needs a sealed hierarchy
 * and a `Match` taking a delegate per case to get the same guarantee, because a `switch` over a
 * hierarchy there is not exhaustiveness-checked however closed the hierarchy is.
 */
function outcome(name: string, replies: readonly Decl[]): string[] {
  return [
    ...doc([
      `Exactly one of the replies the model declares: ${replies
        .map((r) => `\`${qualified(r)}\``)
        .join(" or ")}.`,
      "A `switch` on `kind` narrows `message` to the right type, and `assertNever` on the default " +
        "turns a reply added to the model into a compile error here rather than a surprise later.",
    ]),
    `export type ${name} =`,
    ...replies.map(
      (reply, i) =>
        `  | { readonly kind: ${JSON.stringify(pascal(reply.id.name))}; readonly message: ${pascal(reply.id.name)} }${
          i === replies.length - 1 ? ";" : ""
        }`,
    ),
  ];
}

/**
 * What a service may publish that it does not return.
 *
 * A reply is returned and routed by whatever hosts the handler; everything else the model says a
 * service emits, it emits itself — so without this there is no way to send a `SeatLedgerAdjusted` and
 * the generated interface is unusable. Listing exactly what the model declares is also the point:
 * there is no method for a message the model never said this service sends.
 */
function outbound(
  service: ServiceIr,
  model: LinkedModel,
  needs: Set<string>,
): { lines: string[]; name: string } | undefined {
  const replied = new Set<string>();
  for (const react of service.reacts) for (const decl of repliesOf(react, model)) replied.add(qualified(decl));

  const issued = new Set<string>();
  for (const react of service.reacts) {
    for (const ref of react.issues ?? []) {
      const decl = model.declFor(ref);
      if (decl !== undefined) issued.add(qualified(decl));
    }
  }

  const sends: { emit: EmitIr; decl: Decl; pipe: Decl | undefined }[] = [];
  for (const emit of service.emits) {
    const decl = model.declFor(emit.message);
    if (decl === undefined) continue;
    // A reply travels back through the same `emits`; the handler returns it rather than publishing it.
    if (replied.has(qualified(decl)) && !issued.has(qualified(decl))) continue;
    sends.push({ emit, decl, pipe: model.declFor(emit.pipe) });
  }
  if (sends.length === 0) return undefined;

  const perMessage = new Map<string, number>();
  for (const s of sends) perMessage.set(qualified(s.decl), (perMessage.get(qualified(s.decl)) ?? 0) + 1);

  const name = `${pascal(service.id.name)}Outbound`;
  const methods = sends.flatMap(({ emit, decl, pipe }) => {
    needs.add(need(decl.id.pkg, pascal(decl.id.name)));
    const suffix =
      (perMessage.get(qualified(decl)) ?? 0) > 1 && pipe !== undefined ? `To${pascal(pipe.id.name)}` : "";
    const where = pipe === undefined ? "a pipe that does not resolve" : `\`${qualified(pipe)}\``;
    return [
      ...doc([
        `Publishes \`${qualified(decl)}\` to ${where}.`,
        emit.publication === "atomic"
          ? "Atomic: the model says this message appears on the pipe if and only if the work that " +
            "produced it completed. Publishing it outside that transaction would break the claim."
          : "`best-effort`: the model permits this to be lost even though the work completed. Nothing " +
            "recovers it, so nothing downstream may treat its absence as meaning the work did not happen.",
        ...(emit.version === undefined
          ? []
          : [`Pinned to v${emit.version} by the model, not to the message's own version.`]),
      ]),
      `publish${pascal(decl.id.name)}${suffix}(message: ${pascal(decl.id.name)}, signal?: AbortSignal): Promise<void>;`,
      "",
    ];
  });

  return {
    name,
    lines: [
      ...doc([`Everything \`${qualified(service)}\` is permitted to publish, and nothing else.`]),
      `export interface ${name} {`,
      ...indent(methods.slice(0, -1)),
      "}",
    ],
  };
}

/**
 * The interfaces for one service, or nothing where there is nothing to state.
 *
 * An `@external` service is somebody else's code — the model describes it so the system can be
 * reasoned about whole, not so it can be implemented here. Generating an interface for one would
 * invite somebody to implement it, which is the opposite of what `@external` says.
 */
export function handlersFor(decl: Decl, ctx: Context, host: Host): Handlers | undefined {
  if (decl.kind !== "service" || decl.external) return undefined;
  if (decl.reacts.length === 0 && decl.emits.length === 0) return undefined;

  const model = ctx.model;
  const needs = new Set<string>();
  const losses: Loss[] = [];
  const name = `${pascal(decl.id.name)}`;
  const members: string[] = [];
  const outcomes: string[] = [];

  const envelopes = (model.packages.get(decl.id.pkg)?.envelopes ?? [])
    .map((ref) => model.declFor(ref))
    .filter((d): d is Decl => d !== undefined);
  for (const envelope of envelopes) needs.add(need(envelope.id.pkg, pascal(envelope.id.name)));

  const port = outbound(decl, model, needs);
  const handlers: HandlerSymbol[] = [];
  const dispatches: Dispatch[] = [];

  for (const react of decl.reacts) {
    const message = model.declFor(react.message);
    if (message === undefined) continue;
    needs.add(need(message.id.pkg, pascal(message.id.name)));

    const method = methodName(react, decl, model);
    // Recorded here, from the call that names the method in the file below.
    handlers.push({
      message: `${message.id.pkg}.${message.id.name}`,
      method,
      declaredBy: pascal(decl.id.name),
    });
    const replies = repliesOf(react, model);
    for (const reply of replies) needs.add(need(reply.id.pkg, pascal(reply.id.name)));

    const outcomeName = `${pascal(method.replace(/^handle/, ""))}Outcome`;
    if (replies.length > 1) outcomes.push(...outcome(outcomeName, replies), "");

    if (host.devHost) {
      // Collected from the same values that write the signature, so the dispatcher cannot call the
      // method with the wrong arguments or in the wrong order. The reply is named as the `replies`
      // clause spells it, which is the one spelling guaranteed to resolve at the other end: it
      // resolved when the model was linked, from the package the runtime will resolve it from.
      const missing = [message, ...envelopes].filter((d) => !host.decodes(d));
      if (missing.length > 0) {
        losses.push({
          construct: "subscription",
          at: `${qualified(decl)} / ${qualified(message)}`,
          fidelity: "none",
          detail:
            `The development host decodes what it dispatches, and ${missing
              .map((d) => `\`${qualified(d)}\``)
              .join(", ")} has no decoder — \`decoders\` is off for it. So this subscription has no ` +
            `case, and a scenario delivering \`${qualified(message)}\` here will say the host does ` +
            `not react to it. Casting instead would be a claim nobody checked, which is the one ` +
            `thing a decoder exists to refuse.`,
        });
      } else {
        for (const one of [message, ...envelopes]) {
          needs.add(need(one.id.pkg, `decode${pascal(one.id.name)}`));
        }
        dispatches.push({
          type: `${message.id.pkg}.${message.id.name}`,
          subscription: react.subscription,
          isDefault: react.subscription === decl.id.name,
          method,
          args: [
            `sevenKDecoded(${JSON.stringify(qualified(message))}, decode${pascal(message.id.name)}(message.body))`,
            // Every declared envelope record reads from the one flattened map (D50). A decoder reads
            // tolerantly, so a second envelope's fields sitting beside this one's are ignored rather
            // than reported — which is what makes reading each record out of one map work at all.
            ...envelopes.map(
              (e) =>
                `sevenKDecoded(${JSON.stringify(qualified(e))}, decode${pascal(e.id.name)}(message.envelope.fields))`,
            ),
          ],
          replies: (react.replies ?? [])
            .filter((r): r is Ref => r !== "none")
            .flatMap((ref) => {
              const reply = model.declFor(ref);
              return reply === undefined ? [] : [{ case: pascal(reply.id.name), reply: ref.text }];
            }),
        });
      }
    }

    const returns =
      replies.length === 0
        ? "Promise<void>"
        : replies.length === 1
          ? `Promise<${pascal(replies[0]!.id.name)}>`
          : `Promise<${outcomeName}>`;

    const parameters = [
      `message: ${pascal(message.id.name)}`,
      ...envelopes.map((e) => `${camel(e.id.name)}: ${pascal(e.id.name)}`),
      // The TypeScript equivalent of a cancellation token, and the thing `fetch` already takes.
      "signal?: AbortSignal",
    ];

    members.push(
      ...doc([
        `Handles \`${qualified(message)}\`${react.subscription === decl.id.name ? "" : ` as \`${react.subscription}\``}.`,
        ...contract(react, model),
      ]),
      `// TODO: decide what \`${message.id.name}\` does here.`,
      replies.length === 0
        ? "//       The model declares no reply, so resolving without rejecting is the whole outcome."
        : replies.length === 1
          ? `//       Return the \`${qualified(replies[0]!)}\` the model declares as the outcome.`
          : `//       Return one of the ${replies.length} declared outcomes; the model does not say which, and cannot.`,
      ...(port === undefined ? [] : [`//       Anything else this sends goes through \`${port.name}\`.`]),
      `${method}(`,
      // Every parameter carries a comma, including the last: a trailing one is legal here and means
      // a parameter added later is a one-line diff.
      ...indent(parameters.map((p) => `${p},`)),
      `): ${returns};`,
      "",
    );
  }

  const lines: string[] = [...outcomes];

  if (members.length > 0) {
    lines.push(
      ...doc([
        `What \`${qualified(decl)}\` must handle. The model states the contract; the body is yours.`,
        "Generated from a 7K model, which describes a service's interface and never its internals " +
          "(`03-topology.md` 2.0). Delivery, deduplication, retry and authorization are declared above " +
          "each method and provided by whatever hosts it — they are not implemented here, and the " +
          "comments say which of them still ask something of your code.",
      ]),
      `export interface ${name} {`,
      ...indent(members.slice(0, -1)),
      "}",
    );
  }

  if (port !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(...port.lines);
  }

  const adapter =
    dispatches.length === 0
      ? []
      : adapterFor(qualified(decl), name, `${camel(decl.id.name)}DevHost`, port?.name, dispatches);
  if (adapter.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...adapter);
  }
  for (const lost of reachable(dispatches).lost) losses.push(unreachable(qualified(decl), lost));

  if (lines.length === 0) return undefined;
  return {
    lines,
    losses,
    needs,
    runtime: new Set(adapter.length === 0 ? [] : runtimeFor(dispatches)),
    handlers,
  };
}
