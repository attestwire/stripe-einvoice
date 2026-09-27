import { minimalXRechnung } from "@attestwire/en16931";

import type {
  StripeCreditNote,
  StripeCreditNoteLine,
  StripeInvoice,
  StripeInvoiceLine,
  StripeMappingOptions,
} from "../src/mapping.js";

// The seller and payment come from the engine's own conformant XRechnung
// fixture, so every finding in this suite is about the Stripe mapping, not
// about an incomplete seller/payment block.
export const OPTS: StripeMappingOptions = {
  seller: minimalXRechnung.seller,
  payment: minimalXRechnung.payment!,
  buyerReference: "04011000-1234512345-06",
};

export const rate = (id: string, percentage: number) => ({ tax_rate: { id, percentage } });

/** A finalized Stripe invoice, shaped as a recent API version returns it. */
export function stripeInvoice(lines: StripeInvoiceLine[], overrides: Partial<StripeInvoice> = {}): StripeInvoice {
  return {
    id: "in_test_1",
    number: "ACME-0042",
    created: 1_789_000_000,
    status_transitions: { finalized_at: 1_789_003_600 },
    due_date: 1_790_209_600,
    currency: "eur",
    customer_name: "Beispiel Handels GmbH",
    customer_email: "ap@beispiel.example",
    customer_address: { line1: "Hauptstraße 5", city: "Köln", postal_code: "50667", country: "DE" },
    customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
    lines: { data: lines, has_more: false },
    total: 0,
    ...overrides,
    // Unpaid unless the test says otherwise.
    amount_remaining: overrides.amount_remaining ?? overrides.total ?? 0,
  };
}

/** A Stripe credit note against that same invoice. */
export function stripeCreditNote(
  lines: StripeCreditNoteLine[],
  overrides: Partial<StripeCreditNote> = {},
): StripeCreditNote {
  return {
    id: "cn_test_1",
    number: "ACME-CN-0007",
    invoice: "in_test_1",
    created: 1_789_500_000,
    currency: "eur",
    reason: "duplicate",
    customer_name: "Beispiel Handels GmbH",
    customer_email: "ap@beispiel.example",
    customer_address: { line1: "Hauptstraße 5", city: "Köln", postal_code: "50667", country: "DE" },
    customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
    lines: { data: lines, has_more: false },
    total: 0,
    ...overrides,
  };
}

// Two tax-exclusive lines at two rates, one with a coupon: 2 × 49.00 − 9.80
// at 19 %, and 12.50 at 7 %. Stripe's total is what Stripe would compute.
export const exclusiveLines: StripeInvoiceLine[] = [
  {
    id: "il_seat",
    description: "Pro plan, per seat",
    amount: 9800,
    quantity: 2,
    pricing: { unit_amount_decimal: "4900" },
    discount_amounts: [{ amount: 980 }],
    taxes: [
      {
        amount: 1676,
        tax_behavior: "exclusive",
        taxability_reason: "standard_rated",
        taxable_amount: 8820,
        tax_rate_details: rate("txr_de19", 19),
      },
    ],
    period: { start: 1_786_000_000, end: 1_788_592_000 },
  },
  {
    id: "il_book",
    description: "Printed handbook",
    amount: 1250,
    quantity: 1,
    pricing: { unit_amount_decimal: "1250" },
    taxes: [
      {
        amount: 88,
        tax_behavior: "exclusive",
        taxability_reason: "reduced_rated",
        taxable_amount: 1250,
        tax_rate_details: rate("txr_de7", 7),
      },
    ],
  },
];
