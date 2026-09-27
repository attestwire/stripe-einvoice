# @attestwire/stripe-einvoice

Turn a finalized Stripe invoice into a compliant EN 16931 e-invoice —
**XRechnung UBL** or **Factur-X / ZUGFeRD CII XML** — entirely with the local,
zero-dependency [`@attestwire/en16931`](https://www.npmjs.com/package/@attestwire/en16931)
engine. No account, no per-invoice cost, no network call, unless you opt into
the hosted API's PDF.

Stripe's own invoicing does not generate a compliant e-invoice by itself: it
has your account name and country, not the address, VAT number, contact
details and payment instructions an XRechnung or Factur-X invoice must carry,
and its "Finalize" event is a payment document, not a tax document in the
EN 16931 sense. This package is the missing mapping layer.

## Install

```bash
npm install @attestwire/stripe-einvoice
```

Node 18+. If you also want typed access to the real Stripe SDK objects (rather
than raw webhook JSON), install `stripe` yourself — this package accepts both
and depends on neither.

## Quickstart

```ts
import { writeFileSync } from "node:fs";
import Stripe from "stripe";
import { stripeInvoiceToXml } from "@attestwire/stripe-einvoice";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function exportInvoice(invoiceId: string) {
  const invoice = await stripe.invoices.retrieve(invoiceId);

  // The invoice embeds its first 10 lines. Fetch them all.
  const lines = [];
  for await (const line of stripe.invoices.listLineItems(invoiceId, { limit: 100 })) lines.push(line);

  // Stripe states each line's tax amount, but the percentage lives on the tax rate.
  const rateIds = new Set(
    lines.flatMap((l) => (l.taxes ?? []).map((t) => t.tax_rate_details?.tax_rate)).filter((r) => typeof r === "string"),
  );
  const taxRates = Object.fromEntries(
    await Promise.all([...rateIds].map(async (id) => [id, await stripe.taxRates.retrieve(id)])),
  );

  // Validates first (validateInput), then generates. Throws with every rule,
  // business term and fix if the invoice does not satisfy the profile.
  const { xml, profile, notes } = stripeInvoiceToXml(
    { ...invoice, lines: { data: lines, has_more: false } },
    {
      seller: {
        name: "Your Company GmbH",
        vatId: "DE123456789",
        address: { line1: "Musterstraße 1", city: "Berlin", postalCode: "10115", countryCode: "DE" },
        electronicAddress: { schemeId: "EM", value: "invoices@yourcompany.example" },
        contact: { name: "Accounts", email: "invoices@yourcompany.example", phone: "+49 30 1234567" },
      },
      payment: { meansCode: "58", iban: "DE02120300000000202051" }, // SEPA credit transfer
      // BT-10, required by XRechnung: the buyer's Leitweg-ID (public sector) or
      // the reference they gave you. Or set metadata.buyer_reference in Stripe.
      buyerReference: invoice.metadata?.buyer_reference ?? "your-customer-reference",
      taxRates,
    },
  );

  for (const note of notes) console.warn(note);
  writeFileSync(`${invoice.number}.xml`, xml);
}
```

### From a webhook

```ts
import { invoiceFinalizedEventToXml } from "@attestwire/stripe-einvoice";

app.post("/webhooks/stripe", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.rawBody, req.headers["stripe-signature"], endpointSecret);
  if (event.type !== "invoice.finalized") return res.sendStatus(200);

  // event.data.object.lines embeds only the first 10 lines — expand as above
  // if your invoices can have more, then rebuild the event's invoice object.
  const { xml, profile } = invoiceFinalizedEventToXml(event, options);
  // ... store xml, attach to the invoice record, send to the buyer, etc.
  res.sendStatus(200);
});
```

`invoiceFinalizedEventToXml` and `stripeInvoiceToXml` run **only** the local
engine: mapping, `validateInput`, then `generateXRechnungUBL` or `generateCii`
depending on `profile`. Nothing is sent anywhere. A fatal validation finding
throws before anything is generated, with every failing rule, the business
term it constrains, and the fix.

For CII instead of UBL, pass `profile: "xrechnung-cii"` (XRechnung, CII
syntax) or `profile: "facturx-en16931"` (the CII payload of a Factur-X /
ZUGFeRD PDF). **This library writes the Factur-X XML, not the PDF** — see
[Optional: the hosted PDF](#optional-the-hosted-pdf) below, or embed the XML
yourself with a PDF/A-3 tool of your choice.

## What Stripe doesn't know, and how to supply it

Pass these as `options` to every function in this package:

| Missing from Stripe | Option | Why |
| --- | --- | --- |
| Your legal name, address, VAT ID, contact | `seller: Party` | Stripe has your account name and country, not the seller block BG-4/BG-5/BG-6 requires. |
| How to pay you | `payment: PaymentInstructions` | XRechnung requires payment instructions (BG-16, rule BR-DE-1) — e.g. `{ meansCode: "58", iban }`. |
| The buyer reference | `buyerReference` | XRechnung requires BT-10 (BR-DE-15). For a German public-sector buyer this is their Leitweg-ID. Falls back to `metadata.buyer_reference` on the Stripe object. |
| Peppol participant IDs | `seller.electronicAddress` / `buyer.electronicAddress` | `{ schemeId, value }` — e.g. a German seller's Leitweg-ID scheme `"9930"`, or scheme `"EM"` with an email address (what this package defaults the buyer to, from `customer_email`). |
| VAT exemption reason text | `vatExemptionReasons` | BT-120. Category `E` (exempt) has no standard wording and needs one per BR-E-10; `AE`/`K`/`G`/`O` get sensible defaults from the engine. |
| Tax rate percentages | `taxRates` | Stripe states a line's tax **amount**, not its percentage — that's on the `TaxRate` object. Retrieve the invoice with `expand: ["lines.data.taxes.tax_rate_details.tax_rate"]`, or pass the rates you already have. |

Nothing is invented on your behalf: a missing customer name or address goes
through as an empty string, and `validateInput` (or the throw from
`stripeInvoiceToXml`) reports the exact rule — BR-07, BR-11, BR-DE-8, and so
on — rather than silently passing with a placeholder.

## How it maps

| EN 16931 | From Stripe |
|---|---|
| BT-1 invoice number | `number` (a draft has none, so drafts are refused) |
| BT-2 issue date | `status_transitions.finalized_at`, else `created` |
| BT-9 due date | `due_date` |
| BT-44 / BG-8 buyer | `customer_name`, `customer_address` |
| BT-48 buyer VAT ID | the `eu_vat` entry in `customer_tax_ids`, else any `*_vat` |
| BT-49 buyer electronic address | `customer_email`, scheme `EM` |
| BT-129 / BT-146 quantity, net price | `quantity_decimal`, `pricing.unit_amount_decimal` (tax-exclusive); `taxable_amount ÷ quantity` (tax-inclusive) |
| BT-149 base quantity | the line quantity, when the unit amount does not multiply out to the line amount (package or tiered pricing) |
| BG-27 line allowance | the line's `discount_amounts` (tax-exclusive lines) |
| BT-151 / BT-152 VAT category, rate | `taxability_reason` and the tax rate's `percentage` |
| BG-26 line period | the line's `period` |
| BT-113 paid amount | `total − amount_remaining`: card payments, customer balance and credits alike |

VAT categories: `standard_rated` and `reduced_rated` become S, `zero_rated`
becomes Z, `reverse_charge` becomes AE, the `*_exempt` reasons become E, and
`not_subject_to_tax` becomes O. An exempt (E) line also needs
`vatExemptionReasons: { E: "…" }` (BR-E-10). The invoice's own
`customer_tax_exempt` snapshot (`"none"` / `"exempt"` / `"reverse"`) is
cross-checked against the lines' own categories, and a mismatch — Stripe
recorded the customer as reverse-charge but no line came out AE — is
returned as a `note`, not silently dropped.

## What it refuses, and why

`stripeInvoiceToInput` / `stripeCreditNoteToInput` throw `StripeMappingError`
with the reason when:

- **the currency has three decimals** (BHD, JOD, KWD, OMR, TND). EN 16931
  amounts have two, and this package won't round money. Zero-decimal
  currencies such as JPY are read in whole units.
- **the amount due includes a previous debt.** EN 16931 has nowhere to carry
  a balance from another invoice.
- **the invoice or credit note is a draft / has no number.**
- **a line has no tax information.** Every EN 16931 line needs a VAT category,
  zero-rated and reverse-charge lines included. Use Stripe Tax or tax rates.
- **a line has two taxes.** An EN 16931 line carries one rate. Split the item.
- **a taxability reason has no single category**, such as `not_collecting`,
  `portion_*` or `proportionally_rated`.
- **the invoice has more lines than are embedded.** Fetch them all with
  `stripe.invoices.listLineItems()` (or `creditNotes.listLineItems()`) first.

## Credit notes

A Stripe **credit note** is a separate object from an invoice, and
`stripeCreditNoteToInput` maps it the same way, with `invoiceTypeCode: "381"`
and every amount stated **positively** — the type code carries the direction,
per the engine's own convention:

```ts
import { stripeCreditNoteToInput } from "@attestwire/stripe-einvoice";
import { generateXRechnungUBL, validateInput } from "@attestwire/en16931";

const creditNote = await stripe.creditNotes.retrieve(id, { expand: ["lines.data.taxes.tax_rate_details.tax_rate"] });
const { input, notes } = stripeCreditNoteToInput(creditNote, {
  ...options,
  // BG-3. Not required by EN 16931 for a credit note, but its absence is
  // flagged (ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE, information level) so an
  // auditor can trace the credit back to what it corrects.
  precedingInvoice: { invoiceNumber: "ACME-0042", issueDate: "2026-09-10" },
});

const result = validateInput(input);
if (result.valid) writeFileSync(`${input.invoiceNumber}.xml`, generateXRechnungUBL(input));
```

This assumes a Stripe credit note line carries the same `taxes` array shape as
an invoice line item. That has held for every credit note this package is
tested against; if your Stripe API version's credit note lines look
different, `stripeCreditNoteToInput` will say exactly which field it could not
find.

## Optional: the hosted PDF

Everything above works with no account. `requestFacturXPdf` is the one thing
in this package that makes a network call, and only when you call it:

```ts
import { requestFacturXPdf } from "@attestwire/stripe-einvoice";
import { validateInput } from "@attestwire/en16931";
import { writeFileSync } from "node:fs";

const facturxInput = { ...input, profile: "facturx-en16931" as const };
if (validateInput(facturxInput).valid) {
  const pdf = await requestFacturXPdf(facturxInput, { apiKey: process.env.ATTESTWIRE_API_KEY! });
  writeFileSync(`${facturxInput.invoiceNumber}.pdf`, pdf);
}
```

It posts your `InvoiceInput` as JSON to `POST https://api.attestwire.com/v1/generate?format=pdf`
with `Authorization: Bearer <apiKey>`, and resolves to the PDF's raw bytes: an
A4 invoice drawn from your JSON, written as PDF/A-3B, with the CII embedded as
`factur-x.xml` — a **Factur-X / ZUGFeRD PDF (EN 16931 profile)**. It is a paid
plan feature; a free-plan key gets a `HostedApiError` with `status === 402`,
`code === "plan_required"` and `upgradeUrl` pointing at the pricing page,
before anything is charged. See
[api.attestwire.com/docs](https://api.attestwire.com/docs#facturx-pdf) for the
full contract, rate limits and error codes. Get a free API key at
`POST /v1/keys` (no card required for the free plan).

`requestFacturXPdf` only ever accepts `profile: "facturx-en16931"` — the only
profile a Factur-X PDF can carry — and refuses locally, without a network
call, for any other profile.

## API

```ts
stripeInvoiceToInput(invoice, options): { input: InvoiceInput; notes: string[] }
stripeCreditNoteToInput(creditNote, options): { input: InvoiceInput; notes: string[] }
stripeInvoiceToXml(invoice, options): { input, xml, profile, syntax, notes }
invoiceFinalizedEventToXml(event, options): { input, xml, profile, syntax, notes }
requestFacturXPdf(input, { apiKey, origin?, fetch? }): Promise<Uint8Array>
```

All the Stripe-shaped types (`StripeInvoice`, `StripeInvoiceLine`,
`StripeCreditNote`, `StripeMappingOptions`, …) and `StripeMappingError` /
`HostedApiError` are exported too. See the source doc-comments in
[`src/mapping.ts`](src/mapping.ts), [`src/webhook.ts`](src/webhook.ts) and
[`src/hosted.ts`](src/hosted.ts) for the full field-by-field reasoning —
they're written to be read.

## Scope, honestly

**In scope:** mapping a finalized Stripe invoice or credit note to an EN 16931
`InvoiceInput`; local, free generation and validation of XRechnung UBL and
Factur-X/XRechnung CII XML; a webhook helper; an optional hosted-API PDF
helper.

**Not in scope:**

- **Building the Factur-X PDF/A-3 container yourself, offline.** This package
  (like the underlying engine) reads Factur-X PDFs but does not write one
  locally — only the hosted API does, as a paid feature. If you need a fully
  offline PDF pipeline, embed the CII XML with a PDF/A-3 library of your own.
- **Transmission.** Nothing is sent to a buyer, a Peppol access point or
  Chorus Pro. This package produces the document; delivery is yours.
- **More than one tax jurisdiction per line**, or two taxes on one line — an
  EN 16931 line has exactly one VAT category and rate.
- **Stripe invoices in more than one currency mismatch** — VAT reporting in a
  currency other than the invoice's own (BT-6/BT-111) needs an exchange rate
  Stripe does not carry; supply `vatAccountingCurrency` /
  `taxAmountInAccountingCurrency` on the mapped `input` yourself if you need
  it.

## Development

```bash
npm install
npm test          # vitest run
npm run typecheck
npm run build      # tsc
```

## Related

- [`@attestwire/en16931`](https://github.com/attestwire/en16931): the rule
  engine this package maps Stripe invoices into.
- [Rule reference](https://attestwire.com/rules/): one page per rule, with the
  reason and the fix.
- [Attestwire API docs](https://api.attestwire.com/docs): the hosted
  validate/generate API `requestFacturXPdf` calls.

## License

MIT.

## Trademark

"Attestwire"™ and the Attestwire logo are trademarks of this project's owner. The
MIT license covers the code and grants no trademark rights. You may say your
integration uses this package, or is built on it; you may not name or brand a
product or service "Attestwire", or imply that we endorse yours.
