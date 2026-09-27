import { describe, expect, it } from "vitest";

import { parseCiiInvoice, parseUbl, validateInput } from "@attestwire/en16931";

import { StripeMappingError } from "../src/mapping.js";
import { invoiceFinalizedEventToXml, stripeInvoiceToXml } from "../src/webhook.js";
import { OPTS, exclusiveLines, stripeInvoice } from "./fixtures.js";

describe("invoiceFinalizedEventToXml", () => {
  it("turns an invoice.finalized event into XRechnung UBL by default", () => {
    const event = { type: "invoice.finalized", data: { object: stripeInvoice(exclusiveLines, { total: 11834 }) } };
    const { xml, profile, syntax, notes, input } = invoiceFinalizedEventToXml(event, OPTS);

    expect(profile).toBe("xrechnung-ubl");
    expect(syntax).toBe("ubl");
    expect(notes).toEqual([]);
    expect(input.invoiceNumber).toBe("ACME-0042");

    const parsed = parseUbl(xml).invoice;
    expect(validateInput(parsed).errors).toEqual([]);
  });

  it("emits CII when the options ask for the facturx-en16931 profile", () => {
    const event = { type: "invoice.finalized", data: { object: stripeInvoice(exclusiveLines, { total: 11834 }) } };
    const { xml, profile, syntax } = invoiceFinalizedEventToXml(event, { ...OPTS, profile: "facturx-en16931" });

    expect(profile).toBe("facturx-en16931");
    expect(syntax).toBe("cii");
    const parsed = parseCiiInvoice(xml).invoice;
    expect(validateInput(parsed).errors).toEqual([]);
  });

  it("refuses an event that is not invoice.finalized", () => {
    const event = { type: "invoice.payment_failed", data: { object: stripeInvoice(exclusiveLines, { total: 11834 }) } };
    expect(() => invoiceFinalizedEventToXml(event, OPTS)).toThrow(/invoice\.finalized/);
  });

  it("throws with every rule, term and fix when the mapped invoice fails validation", () => {
    // No buyerReference and no options override: BR-DE-15 fires.
    const invoice = stripeInvoice(exclusiveLines, { total: 11834, metadata: {} });
    expect(() => stripeInvoiceToXml(invoice, { seller: OPTS.seller, payment: OPTS.payment })).toThrow(/BR-DE-15/);
  });

  it("never generates XML for an invalid invoice", () => {
    // Sabotage the buyer so BR-07 fires, and confirm the thrown error is a
    // StripeMappingError carrying the rule, not a generator crash.
    const invoice = stripeInvoice(exclusiveLines, { total: 11834, customer_name: null });
    let threw: unknown;
    try {
      stripeInvoiceToXml(invoice, OPTS);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(StripeMappingError);
    expect(String(threw)).toMatch(/BR-07/);
  });
});
