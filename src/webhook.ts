/**
 * Turn a Stripe `invoice.finalized` webhook event straight into e-invoice XML,
 * generated and validated with the local engine. No network call: everything
 * here runs against `@attestwire/en16931` in your own process.
 *
 * ```ts
 * const event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
 * const { xml, profile, notes } = invoiceFinalizedEventToXml(event, {
 *   seller, payment, buyerReference,
 * });
 * ```
 *
 * The Stripe invoice embeds only its first 10 lines (see the package README);
 * fetch them all with `stripe.invoices.listLineItems()` before constructing
 * the event object you pass here, exactly as the mapping layer requires.
 */

import { generateCii, generateXRechnungUBL, validateInput, type InvoiceInput, type Profile } from "@attestwire/en16931";

import { StripeMappingError, stripeInvoiceToInput, type StripeInvoice, type StripeMappingOptions } from "./mapping.js";

/** The subset of a Stripe `Event` this reads: `{ type, data: { object } }`. */
export interface StripeInvoiceFinalizedEvent {
  type: string;
  data: { object: StripeInvoice };
}

export interface FinalizedInvoiceXml {
  /** The `InvoiceInput` this was generated from, in case you want to store or re-render it. */
  input: InvoiceInput;
  /** The complete XML document: XRechnung UBL, or the CII payload of a Factur-X/ZUGFeRD file. */
  xml: string;
  profile: Profile;
  syntax: "ubl" | "cii";
  /** Things worth a look that did not block generation, such as a cent of VAT rounding against Stripe. */
  notes: string[];
}

/** Profiles `generateCii` accepts. Every other profile is UBL. */
const CII_PROFILES = new Set<Profile>(["xrechnung-cii", "facturx-en16931"]);

/**
 * `event.type` must be `"invoice.finalized"`. Throws `StripeMappingError`
 * otherwise, naming the type it got — a webhook endpoint that fans out several
 * event types should check `event.type` itself before calling this, but the
 * check is here too so a mistake fails loudly instead of generating XML for
 * the wrong occasion.
 */
export function invoiceFinalizedEventToXml(
  event: StripeInvoiceFinalizedEvent,
  opts: StripeMappingOptions,
): FinalizedInvoiceXml {
  if (event.type !== "invoice.finalized") {
    throw new StripeMappingError(
      `invoiceFinalizedEventToXml expects an "invoice.finalized" event, got "${event.type}".`,
    );
  }
  return stripeInvoiceToXml(event.data.object, opts);
}

/**
 * The same conversion without the webhook envelope, for when you already have
 * the Stripe invoice object (a scheduled export, a backfill, a retry).
 *
 * Maps the invoice, then validates the result with `validateInput` BEFORE
 * generating anything: a fatal finding throws, naming every rule, the
 * business term and the fix, exactly as `validateInput` reports it — so
 * nothing that would fail the regulation is ever handed to a generator.
 */
export function stripeInvoiceToXml(invoice: StripeInvoice, opts: StripeMappingOptions): FinalizedInvoiceXml {
  const { input, notes } = stripeInvoiceToInput(invoice, opts);
  const result = validateInput(input);
  if (!result.valid) {
    const lines = result.errors.map((e) => {
      const field = Array.isArray(e.field) ? e.field.join(", ") : e.field;
      return `  ${e.rule} (${field}): ${e.message}\n    fix: ${e.fix}`;
    });
    throw new StripeMappingError(
      [`Stripe invoice ${invoice.number ?? invoice.id} does not satisfy profile "${input.profile}":`, ...lines].join(
        "\n",
      ),
    );
  }

  const syntax: "ubl" | "cii" = CII_PROFILES.has(input.profile) ? "cii" : "ubl";
  const xml = syntax === "cii" ? generateCii(input) : generateXRechnungUBL(input);
  return { input, xml, profile: input.profile, syntax, notes };
}
