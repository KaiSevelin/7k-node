# 7k-node

A [7K](https://github.com/KaiSevelin/7k) provider that generates **TypeScript 5 / Node 20** from a 7K
model: branded types, decoders, handler interfaces and saga state machines.

The companion to [7k-csharp](https://github.com/KaiSevelin/7k-csharp) — same three layers, a language
where the interesting problems are different ones. C# has a `Guid` type; TypeScript has a string that
somebody claims is a uuid.

## What it generates

| From the model | In TypeScript |
| --- | --- |
| `message`, `record` | an `interface`, with absent optionals absent rather than `null` |
| `value` | a **branded** type, so a bare string is not assignable by accident |
| `enum` | a union of the member names as written |
| field and value constraints | a decoder returning every problem with its path: `items[0].qty` |
| `invariant` | a check across fields and across lists |
| `service` | an interface whose outcomes are a discriminated union, taking an `AbortSignal` |
| `saga` | a state machine returning effects, with no I/O of its own |

A decoder is the point. JSON carries no types, so `decodePlaceOrder(payload)` returns
`{ ok: true, value }` or every problem it found — never a cast. `decimal(p,s)` must be a **string** at
exactly the declared scale: a number is a double, and money must not round-trip through one.

## Options

| Option | Values | Default |
| --- | --- | --- |
| `valueTypes` | `brand` \| `alias` | `brand` |
| `decoders` | boolean | `true` |
| `handlers` | boolean | `true` |
| `sagas` | boolean | `true` |
| `extension` | `.js` \| `""` | `.js` |
| `index` | boolean | `true` |

## Verification

```
npm test            # 55 tests, including what this provider may depend on
npm run verify      # tsc under a consumer's own strictness, then runs the output
npm run equivalence # the generated saga vs. 7K's reference engine, 7 scripts
```

`npm run verify` compiles the generated modules under strict settings a *consumer* would choose, not
ones chosen to pass, and then runs behavioural checks: a payload satisfying every rule is accepted, and
a payload breaking one is refused with a problem naming the field. Each case is the valid payload with a
**single** thing changed, because a case that happens to break a second rule is refused for the wrong
reason and proves nothing.

`npm run equivalence` is better here than the equivalent check for C#, and worth the note: both sides are
TypeScript, so the generated machine and the 7K sandbox's own saga engine are imported into **one
process** and driven from one script. There is no cross-language harness, no interchange format and no
decision string to compare across a gap — three things that can disagree for reasons that have nothing
to do with sagas. The only thing that can differ is a decision.

## What it depends on

The 7K **language** (`@sevenk/core`, for the IR and its `flatFieldsOf`) and the **provider contract**
(`@sevenk/provider`, which is types and contains no code). Deliberately *not* `@sevenk/generate`, the
host that runs providers — there is more than one host, and a provider is not supposed to be able to
tell which one called it. `test/coupling.test.ts` holds that line, and pins that nothing in `src/` can
reach a filesystem, a network or a subprocess: a provider returns text, and the caller decides what
becomes of it.

The 7K sandbox is a dev dependency, used only by the equivalence harness.

## Status

Not yet installable on its own: `package.json` resolves `@sevenk/core`, `@sevenk/provider` and
`@sevenk/sandbox` through `file:` paths, so it currently expects checkouts of
[7K](https://github.com/KaiSevelin/7k) and
[7k-sandbox](https://github.com/KaiSevelin/7k-sandbox) beside this one.

Apache-2.0.
