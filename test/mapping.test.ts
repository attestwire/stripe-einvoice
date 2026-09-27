import { describe, expect, it } from "vitest";

import { computeTotals, generateCii, generateXRechnungUBL, parseCiiInvoice, parseUbl, validateInput } from "@attestwire/en16931";

import { StripeMappingError, stripeCreditNoteToInput, stripeInvoiceToInput } from "../src/mapping.js";
import type { StripeCreditNoteLine, StripeInvoiceLine } from "../src/mapping.js";
import { OPTS, exclusiveLines, rate, stripeCreditNote, stripeInvoice } from "./fixtures.js";

describe("stripeInvoiceToInput", () => {
  it("maps a tax-exclusive invoice with a coupon to a valid XRechnung that matches Stripe's total", () => {
    const { input, notes } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834 }), OPTS);

    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(notes).toEqual([]);
    expect(computeTotals(input).taxInclusiveAmount).toBe(118.34);

    expect(input.invoiceNumber).toBe("ACME-0042");
    expect(input.issueDate).toBe("2026-09-10"); // finalized_at, not created
    expect(input.currency).toBe("EUR");
    expect(input.buyer.vatId).toBe("DE123456789");
    expect(input.buyer.electronicAddress).toEqual({ schemeId: "EM", value: "ap@beispiel.example" });
    expect(input.lines[0]).toMatchObject({
      quantity: 2,
      unitPrice: 49,
      vatCategory: "S",
      vatRate: 19,
      allowances: [{ amount: 9.8, reasonCode: "95" }],
      period: { startDate: "2026-08-06", endDate: "2026-09-05" },
    });
    expect(input.lines[1]).toMatchObject({ unitPrice: 12.5, vatRate: 7 });
  });

  it("generates UBL and CII that read back and validate", () => {
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834 }), OPTS);

    const ubl = parseUbl(generateXRechnungUBL(input)).invoice;
    expect(validateInput(ubl).errors).toEqual([]);

    const cii = parseCiiInvoice(generateCii({ ...input, profile: "xrechnung-cii" })).invoice;
    expect(validateInput(cii).errors).toEqual([]);
    expect(computeTotals(cii).payableAmount).toBe(118.34);
  });

  it("derives the net price of a tax-inclusive line from taxable_amount", () => {
    const line: StripeInvoiceLine = {
      id: "il_gross",
      description: "Annual licence (price incl. VAT)",
      amount: 11900,
      quantity: 3,
      pricing: { unit_amount_decimal: "3966.666666666667" },
      taxes: [
        {
          amount: 1900,
          tax_behavior: "inclusive",
          taxability_reason: "standard_rated",
          taxable_amount: 10000,
          tax_rate_details: rate("txr_de19", 19),
        },
      ],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 11900 }), OPTS);
    expect(validateInput(input).errors).toEqual([]);
    expect(notes).toEqual([]);
    const totals = computeTotals(input);
    expect(totals.lineExtensionAmount).toBe(100);
    expect(totals.taxInclusiveAmount).toBe(119);
  });

  it("maps a reverse-charge sale to an EU business as category AE", () => {
    const line: StripeInvoiceLine = {
      id: "il_rc",
      description: "Consulting",
      amount: 50000,
      quantity: 1,
      pricing: { unit_amount_decimal: "50000" },
      taxes: [
        {
          amount: 0,
          tax_behavior: "exclusive",
          taxability_reason: "reverse_charge",
          taxable_amount: 50000,
          tax_rate_details: rate("txr_rc", 0),
        },
      ],
    };
    const invoice = stripeInvoice([line], {
      total: 50000,
      customer_name: "Exemple SARL",
      customer_address: { line1: "1 rue de la Paix", city: "Paris", postal_code: "75002", country: "FR" },
      customer_tax_ids: [{ type: "eu_vat", value: "FR40303265045" }],
    });
    const { input } = stripeInvoiceToInput(invoice, OPTS);
    expect(input.lines[0]).toMatchObject({ vatCategory: "AE", vatRate: 0 });
    expect(validateInput(input).errors).toEqual([]);
  });

  it("maps a reverse-charge sale flagged via the customer's tax-exempt status, with no mismatch note", () => {
    // Stripe sets customer_tax_exempt: "reverse" on the invoice snapshot when
    // the customer is configured for reverse charge; Stripe Tax then taxes
    // every line at 0% with taxability_reason "reverse_charge".
    const line: StripeInvoiceLine = {
      id: "il_rc2",
      description: "Consulting (EU B2B, reverse charge customer)",
      amount: 75000,
      quantity: 1,
      pricing: { unit_amount_decimal: "75000" },
      taxes: [
        {
          amount: 0,
          tax_behavior: "exclusive",
          taxability_reason: "reverse_charge",
          taxable_amount: 75000,
          tax_rate_details: rate("txr_rc", 0),
        },
      ],
    };
    const invoice = stripeInvoice([line], {
      total: 75000,
      customer_name: "Voorbeeld B.V.",
      customer_tax_exempt: "reverse",
      customer_address: { line1: "Damrak 1", city: "Amsterdam", postal_code: "1012 LG", country: "NL" },
      customer_tax_ids: [{ type: "eu_vat", value: "NL123456789B01" }],
    });
    const { input, notes } = stripeInvoiceToInput(invoice, OPTS);
    expect(input.lines[0]).toMatchObject({ vatCategory: "AE" });
    expect(notes).toEqual([]);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("notes a mismatch when Stripe flags the customer as reverse charge but no line came out AE", () => {
    // A misconfigured tax rate: the customer is marked reverse charge, but the
    // line was taxed standard-rated anyway (e.g. a tax code that ignores the
    // customer's status). This is exactly the drift worth catching before the
    // invoice goes out.
    const invoice = stripeInvoice(exclusiveLines, { total: 11834, customer_tax_exempt: "reverse" });
    const { notes } = stripeInvoiceToInput(invoice, OPTS);
    expect(notes.some((n) => /recorded this customer's tax status as "reverse"/.test(n))).toBe(true);
  });

  it("states a paid invoice's payment as BT-113, so the amount due is zero", () => {
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 0 }), OPTS);
    expect(input.paidAmount).toBe(118.34);
    expect(computeTotals(input).payableAmount).toBe(0);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("counts a customer credit balance as settled, like a card payment", () => {
    // 118.34 total; 18.34 came off the customer's Stripe balance, 100.00 is still due.
    const { input } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 10000 }), OPTS);
    expect(input.paidAmount).toBe(18.34);
    expect(computeTotals(input).payableAmount).toBe(100);
  });

  it("refuses an invoice that carries a previous debt", () => {
    expect(() =>
      stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11834, amount_remaining: 15000 }), OPTS),
    ).toThrow(/previous balance/);
  });

  it("reads a zero-decimal currency in whole units, not hundredths", () => {
    const line: StripeInvoiceLine = {
      id: "il_jpy",
      description: "Plan",
      amount: 1000,
      quantity: 1,
      pricing: { unit_amount_decimal: "1000" },
      taxes: [{ amount: 100, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 1000, tax_rate_details: rate("txr_jp", 10) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { currency: "jpy", total: 1100 }), OPTS);
    expect(input.lines[0]!.unitPrice).toBe(1000);
    expect(computeTotals(input).taxInclusiveAmount).toBe(1100);
    expect(notes).toEqual([]);
  });

  it("keeps package pricing exact through the base quantity", () => {
    // 1,000 units at 5.00 per package of 100: Stripe's unit amount is per package.
    const line: StripeInvoiceLine = {
      id: "il_pkg",
      description: "API calls",
      amount: 5000,
      quantity: 1000,
      pricing: { unit_amount_decimal: "500" },
      taxes: [{ amount: 950, tax_behavior: "exclusive", taxability_reason: "standard_rated", taxable_amount: 5000, tax_rate_details: rate("txr_de19", 19) }],
    };
    const { input, notes } = stripeInvoiceToInput(stripeInvoice([line], { total: 5950 }), OPTS);
    expect(input.lines[0]).toMatchObject({ quantity: 1000, unitPrice: 50, baseQuantity: 1000 });
    expect(computeTotals(input).taxInclusiveAmount).toBe(59.5);
    expect(notes).toEqual([]);
    expect(validateInput(input).errors).toEqual([]);
  });

  it("refuses a three-decimal currency rather than rounding money", () => {
    expect(() => stripeInvoiceToInput(stripeInvoice(exclusiveLines, { currency: "kwd" }), OPTS)).toThrow(/three decimal/);
  });

  it("returns a note when Stripe's total and the EN 16931 total disagree", () => {
    const { notes } = stripeInvoiceToInput(stripeInvoice(exclusiveLines, { total: 11835 }), OPTS);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/118\.35 but the EN 16931 total is 118\.34/);
  });

  it("leaves missing customer data for the validator to name, rather than inventing it", () => {
    const { input } = stripeInvoiceToInput(
      stripeInvoice(exclusiveLines, { total: 11834, customer_name: null, customer_address: null }),
      OPTS,
    );
    const rules = validateInput(input).errors.map((e) => e.rule);
    expect(rules).toContain("BR-07"); // buyer name
    expect(rules).toContain("BR-11"); // buyer country
  });

  it("refuses what EN 16931 cannot express, saying why", () => {
    const refuse = (inv: ReturnType<typeof stripeInvoice>) => () => stripeInvoiceToInput(inv, OPTS);
    expect(refuse(stripeInvoice(exclusiveLines, { number: null }))).toThrow(/draft/);
    expect(refuse(stripeInvoice(exclusiveLines, { lines: { data: exclusiveLines, has_more: true } }))).toThrow(
      /listLineItems/,
    );
    const untaxed = [{ ...exclusiveLines[0]!, taxes: [] }];
    expect(refuse(stripeInvoice(untaxed))).toThrow(/no tax information/);
    const twoTaxes = [{ ...exclusiveLines[0]!, taxes: [...exclusiveLines[0]!.taxes!, ...exclusiveLines[1]!.taxes!] }];
    expect(refuse(stripeInvoice(twoTaxes))).toThrow(/2 taxes/);
    const split = [
      { ...exclusiveLines[0]!, taxes: [{ ...exclusiveLines[0]!.taxes![0]!, taxability_reason: "proportionally_rated" }] },
    ];
    expect(refuse(stripeInvoice(split))).toThrow(StripeMappingError);
  });
});

describe("stripeCreditNoteToInput", () => {
  const creditLines: StripeCreditNoteLine[] = [
    {
      id: "cnli_seat",
      description: "Pro plan, per seat (refund)",
      amount: 9800,
      quantity: 2,
      pricing: { unit_amount_decimal: "4900" },
      taxes: [
        {
          amount: 1862,
          tax_behavior: "exclusive",
          taxability_reason: "standard_rated",
          taxable_amount: 9800,
          tax_rate_details: rate("txr_de19", 19),
        },
      ],
    },
  ];

  it("maps a credit note as invoiceTypeCode 381 with positive amounts", () => {
    const total = 11662; // 98.00 + 18.62 VAT
    const { input, notes } = stripeCreditNoteToInput(stripeCreditNote(creditLines, { total }), {
      ...OPTS,
      precedingInvoice: { invoiceNumber: "ACME-0042", issueDate: "2026-09-10" },
    });

    expect(input.invoiceTypeCode).toBe("381");
    expect(input.invoiceNumber).toBe("ACME-CN-0007");
    expect(input.precedingInvoices).toEqual([{ invoiceNumber: "ACME-0042", issueDate: "2026-09-10" }]);
    expect(input.lines[0]!.unitPrice).toBeGreaterThan(0); // stated positively, not as a negative reversal
    expect(notes).toEqual([]);

    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(computeTotals(input).taxInclusiveAmount).toBe(116.62);
  });

  it("generates a UBL CreditNote that reads back and validates", () => {
    const { input } = stripeCreditNoteToInput(stripeCreditNote(creditLines, { total: 11662 }), OPTS);
    const xml = generateXRechnungUBL(input);
    expect(xml).toContain("CreditNote");
    const parsed = parseUbl(xml).invoice;
    expect(validateInput(parsed).errors).toEqual([]);
  });

  it("flags a missing preceding invoice reference as information, not an error", () => {
    const { input } = stripeCreditNoteToInput(stripeCreditNote(creditLines, { total: 11662 }), OPTS);
    const result = validateInput(input);
    expect(result.errors).toEqual([]);
    expect(result.information.some((f) => f.rule === "ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE")).toBe(true);
  });

  it("refuses a credit note with no number", () => {
    expect(() => stripeCreditNoteToInput(stripeCreditNote(creditLines, { number: null }), OPTS)).toThrow(
      StripeMappingError,
    );
  });
});
