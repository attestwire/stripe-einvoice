# Contributing

This repository is developed in the open, so the normal GitHub flow applies:
fork it, branch, open a pull request. No CLA, no template to sign.

## Where your issue belongs

This package maps a Stripe invoice (or credit note) onto the EN 16931 invoice
model, and optionally calls the hosted Attestwire API for the Factur-X PDF.
**The validation rules and the XML generation come from
[`@attestwire/en16931`](https://github.com/attestwire/en16931).**

So:

- A rule that fired when it shouldn't have, wrong XML in the output, a parsing
  failure — that's the engine. Report it at
  [attestwire/en16931](https://github.com/attestwire/en16931/issues), with the
  XML and the rule ID you expected.
- The Stripe mapping (a field landing on the wrong business term, a Stripe
  invoice or credit note shape this package doesn't handle yet, the webhook
  helper, the hosted PDF helper) — that's here.

## Running the tests

Node 18+.

```bash
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc
```

To run one file while you iterate:

```bash
npx vitest run test/mapping.test.ts
```

`test/fixtures.ts` holds the Stripe invoice and credit note shapes the mapping
tests run against. If you're fixing a mapping bug, the cleanest PR adds the
Stripe shape that broke to that file, asserts the invoice fields it should
produce, and then fixes it.

## Before you open the PR

Run `npm test` and `npm run typecheck`.

## Questions

Open an issue, or email hello@attestwire.com.

Security issues go to hello@attestwire.com. See [SECURITY.md](SECURITY.md).

## Licence

MIT. By contributing, you agree your contribution ships under it.
