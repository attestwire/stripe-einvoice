# Security

## Reporting

Email **hello@attestwire.com**. The maintainer reads these directly.

Include what you found, how to reproduce it, and the package version you were on.
Please don't open a public issue for a security report.

There's no bug bounty. If you'd like credit, say so and you'll be named in the
release notes for the fix.

## Scope

This package runs inside your own server or webhook handler and handles
invoice documents, which carry customer names, addresses, VAT IDs and bank
details, plus your Attestwire API key if you use the optional hosted PDF
helper. Worth reporting:

- Anything that leaks a Stripe invoice, credit note or the generated XML to
  somewhere it shouldn't go — a log line, an error message, a third party.
- Anything that sends your API key anywhere other than the Attestwire API
  origin you configured.
- Injection through Stripe invoice data into the generated XML.
- Anything in `requestFacturXPdf` that makes a network call you did not ask
  for, or that ignores TLS.

## Out of scope

A wrong verdict, or malformed XML out of the generator, is a bug in the rule
engine. Report it at
[attestwire/en16931](https://github.com/attestwire/en16931/issues).

Vulnerabilities in the engine itself (XML parsing, entity expansion, the PDF
reader) belong in that repository's
[SECURITY.md](https://github.com/attestwire/en16931/blob/main/SECURITY.md)
process, same email either way.

Vulnerabilities in the hosted Attestwire API (`api.attestwire.com`) or in
Stripe itself go to Attestwire and Stripe respectively, not this repository.
