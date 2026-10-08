/**
 * A development host per service: your implementation, run inside a 7K Sandbox scenario.
 *
 * The question it answers is the one Spider could not. A drawing of a system cannot send a message to
 * a live service, because nothing in the model says what language that service is written in or how to
 * reach it. So it does not try: it runs the service's own code inside the scenario, under your
 * debugger, with everything it talks to still mocked — and a breakpoint in a handler becomes reachable
 * from the drawing.
 *
 * ### Why this is co-located rather than a file of its own
 *
 * The C# provider writes its dev host into a separate partial-class file guarded by `#if DEBUG`,
 * because a dispatcher compiled into a Release build would be a second entry point into every handler
 * with nothing in front of it. TypeScript needs neither the guard nor the file. It has no conditional
 * compilation, and it does not need any: an exported `const` nobody imports is dropped by every
 * bundler, and the types this is written against are type-only imports that erase outright. So a
 * co-located adapter costs a production build nothing — and a module of its own would have to repeat
 * the relative-import machinery that the grouping already does for the interface beside it.
 *
 * ### Why it decodes instead of casting
 *
 * `message.body as PlaceOrder` would compile and would be a claim nobody checked, which is the one
 * thing `decode.ts` exists to refuse. So every argument goes through the generated decoder.
 *
 * That makes the dev host do something the C# one cannot. There, the delivery is deserialised and the
 * type system settles the shape, so running a handler in a scenario exercises the converters and
 * little else. Here the decoder *is* the checking, so a scenario run through this adapter exercises
 * it — against a payload the scenario has already validated against the same model. If the decoder
 * then refuses it, Core and this provider disagree about the contract, which is a defect in one of
 * them and worth hearing loudly rather than running a handler on a lie.
 *
 * ### Nothing here imports the sandbox
 *
 * TypeScript is structural, so a function of the right shape *is* a `Handler` — the shape is declared
 * in the decode runtime and the sandbox never appears in a generated import. D92 asks this of Spider;
 * it is just as true of generated code, which a consumer must be able to compile without taking a
 * dependency on a test harness.
 */

import type { Loss } from "@sevenk/provider";

/** One subscription, as the thing that named the method describes it. */
export interface Dispatch {
  /** The message's qualified name, which is what a delivery's `envelope.type` carries. */
  readonly type: string;
  /** The subscription's name, which defaults to the service's own. */
  readonly subscription: string;
  /** Whether that name is the service's own, i.e. whether this is the unnamed subscription. */
  readonly isDefault: boolean;
  /** The method this provider named for it. */
  readonly method: string;
  /** The arguments, as expressions, in the order the method takes them. */
  readonly args: readonly string[];
  /**
   * The declared replies, as the `replies` clause spells them, with the outcome case for each.
   *
   * Empty for `replies none`. One for a single reply, which the method returns directly. More than
   * one for an outcome union, where the case carries the message.
   */
  readonly replies: readonly { readonly case: string; readonly reply: string }[];
}

const indent = (lines: readonly string[], by = "  "): string[] =>
  lines.map((l) => (l === "" ? "" : `${by}${l}`));

/**
 * One case per message, and what that costs.
 *
 * **A service may subscribe to the same message twice** — `reacts Withdraw from commands` beside
 * `reacts Withdraw from commands as sweep` — and this provider writes a method for each, which is
 * right: they are two subscriptions with two filters and two retry policies. But a delivery carries
 * the message and not the subscription, because a live handler is handed a message and a message does
 * not know which subscription matched it. So the dispatcher cannot tell them apart. TypeScript will
 * even accept two `case` labels for one value and quietly make the second unreachable, which is worse
 * than C# refusing to compile it.
 *
 * So it keeps the unnamed subscription, which is the one a reader means by "the handler", and reports
 * each other as a `Loss`. Not a refusal: the rest of the module is useful, and a service losing its
 * whole dev host over one extra subscription would be a worse trade. Not silence either — a method
 * that cannot be reached from the thing that exists to reach it is exactly what a loss is for.
 */
export function reachable(dispatches: readonly Dispatch[]): {
  readonly kept: readonly Dispatch[];
  readonly lost: readonly Dispatch[];
} {
  const byType = new Map<string, Dispatch[]>();
  for (const one of dispatches) byType.set(one.type, [...(byType.get(one.type) ?? []), one]);

  const kept: Dispatch[] = [];
  const lost: Dispatch[] = [];
  for (const [, group] of byType) {
    const first = group.find((d) => d.isDefault) ?? group[0]!;
    kept.push(first);
    lost.push(...group.filter((d) => d !== first));
  }
  // Back into the order the interface declares them, so the module reads top to bottom.
  const at = (one: Dispatch): number => dispatches.indexOf(one);
  return { kept: kept.sort((a, b) => at(a) - at(b)), lost: lost.sort((a, b) => at(a) - at(b)) };
}

/** The loss a dropped subscription declares, in the words of the model that declared it. */
export const unreachable = (service: string, one: Dispatch): Loss => ({
  construct: "subscription",
  at: `${service} as ${one.subscription}`,
  fidelity: "none",
  detail:
    `The development host dispatches on the message, and \`${one.type}\` already has a case — a ` +
    `delivery carries the message and not the subscription it matched, so nothing can tell this one ` +
    `from the other. \`${one.method}\` is still generated and still yours to call; it is this host ` +
    `that cannot reach it.`,
});

/** What the adapter refers to from the decode runtime, given what it dispatches. */
export function runtimeFor(dispatches: readonly Dispatch[]): string[] {
  const kept = reachable(dispatches).kept;
  if (kept.length === 0) return [];
  return [
    "SevenKHandler",
    "SevenKMessage",
    "sevenKDecoded",
    ...(kept.some((d) => d.replies.length > 0) ? ["SevenKReply", "sevenKBody"] : []),
  ];
}

/**
 * The adapter for one service.
 *
 * A `switch` on the message's qualified name, because that is what a delivery carries and what the
 * model calls it. Each case decodes its arguments and calls the method — so which code a delivered
 * message runs is written down once, by the thing that named the method.
 */
export function adapterFor(
  service: string,
  iface: string,
  name: string,
  port: string | undefined,
  all: readonly Dispatch[],
): string[] {
  const dispatches = reachable(all).kept;
  if (dispatches.length === 0) return [];

  const answers = dispatches.some((d) => d.replies.length > 0);

  const cases = dispatches.flatMap((one) => {
    const call = [
      `${one.replies.length === 0 ? "" : "const outcome = "}await handler.${one.method}(`,
      ...indent(one.args.map((a) => `${a},`)),
      // `signal` is the last parameter and optional, so it is left unset: the sandbox gives a live
      // handler nothing to cancel it with, and passing an `AbortSignal` that never aborts would say
      // there is one.
      ");",
    ];

    if (one.replies.length === 0) {
      return [`case ${JSON.stringify(one.type)}: {`, ...indent([...call, "return;"]), "}", ""];
    }

    if (one.replies.length === 1) {
      const only = one.replies[0]!;
      return [
        `case ${JSON.stringify(one.type)}: {`,
        ...indent([
          ...call,
          `return { reply: ${JSON.stringify(only.reply)}, body: sevenKBody(outcome) };`,
        ]),
        "}",
        "",
      ];
    }

    return [
      `case ${JSON.stringify(one.type)}: {`,
      ...indent([
        ...call,
        // The reply is named as the `replies` clause spells it, which is the one spelling guaranteed
        // to resolve at the other end: it resolved when the model was linked, from the package the
        // runtime will resolve it from. `kind` is this provider's local type name, and across
        // packages the two differ.
        "const named = {",
        ...indent(one.replies.map((r) => `${r.case}: ${JSON.stringify(r.reply)},`)),
        "} as const;",
        // Total without an `assertNever`: a reply added to the model adds a `kind` this object has
        // no key for, and indexing it is then a compile error here rather than an `undefined` reply
        // the scenario rejects at runtime.
        "return { reply: named[outcome.kind], body: sevenKBody(outcome.message) };",
      ]),
      "}",
      "",
    ];
  });

  return [
    "/**",
    ` * Runs \`${iface}\` inside a 7K Sandbox scenario, under your debugger.`,
    " *",
    " * Hand it your implementation and name the service live:",
    " *",
    " * ```ts",
    " * const trace = await run(model, scenario, {",
    ` *   live: new Map([[${JSON.stringify(service)}, ${name}(new My${iface}())]]),`,
    " * });",
    " * ```",
    " *",
    " * Everything else stays mocked, so a breakpoint in a handler is reached by a scenario rather than",
    " * by a running system — and no wall-clock time passes while it is held, so a `timeout` the model",
    " * declares cannot trip because you stopped to look.",
    " *",
    " * Your implementation is constructed by you, which is the point: whatever it needs is yours to",
    ...(port === undefined
      ? [" * provide."]
      : [
          ` * provide, \`${port}\` included. What it publishes through that port does not reach the`,
          " * scenario — a live handler answers with one reply and cannot send besides it, which is a",
          " * limit of the sandbox's handler contract rather than of this host.",
        ]),
    " *",
    " * The body is decoded rather than cast, so this exercises the generated decoders against a payload",
    " * the scenario has already validated against the same model. A decode failure here means the two",
    " * disagree about the contract, and it is thrown rather than swallowed for exactly that reason.",
    " *",
    " * Nothing above imports the sandbox: TypeScript is structural, so a function of this shape is a",
    " * `Handler` without this module depending on what runs it.",
    " */",
    `export const ${name} =`,
    `  (handler: ${iface}): SevenKHandler =>`,
    `  async (message: SevenKMessage): Promise<${answers ? "SevenKReply | void" : "void"}> => {`,
    ...indent(
      [
        "switch (message.envelope.type) {",
        // Every case keeps its trailing blank line, `default` included: it is the one arm a reader
        // scrolls to, and running it onto the end of the last case hides it.
        ...indent(cases),
        ...indent([
          "default:",
          ...indent([
            "// The scenario routed this here, so it is a fault in the host rather than in the model",
            "// — and it must not be quietly acknowledged, which returning nothing would be.",
            "throw new Error(",
            `  \`7K: \\\`${service}\\\` does not react to \\\`\${message.envelope.type}\\\`\`,`,
            ");",
          ]),
        ]),
        "}",
      ],
      "    ",
    ),
    "  };",
  ];
}
