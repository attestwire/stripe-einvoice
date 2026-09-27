/**
 * A Stripe invoice or credit note → an EN 16931 `InvoiceInput`, ready for
 * `generateXRechnungUBL`, `generateCii` and `validateInput`.
 *
 * Adapted from `@attestwire/en16931`'s `examples/stripe/stripe-to-en16931.ts`
 * recipe (read that file's comments for the original rationale) and packaged
 * so it can be depended on, versioned and tested on its own rather than
 * copy-pasted. The Stripe shapes below are the subset this reads. They accept
 * both the SDK's objects (`stripe` 22, API 2026-08-26.dahlia) and raw API JSON
 * such as a webhook payload, where the decimal fields are strings rather than
 * the SDK's `Decimal`.
 *
 * WHAT STRIPE DOES NOT KNOW, and you must pass in: the seller (Stripe has your
 * account name and country, not your address or VAT number as they must appear
 * on the invoice) and the payment instructions (BG-16, which XRechnung
 * requires by BR-DE-1). See the package README's "What Stripe doesn't know"
 * section.
 *
 * THE DECISIONS, stated here so you can disagree with them in one place:
 *
 * 1. Amounts are Stripe's integer minor units (cents, or whole yen for a
 *    zero-decimal currency). Nothing is re-derived from a rounded decimal. A
 *    tax-exclusive line keeps its unit price and quantity when they multiply
 *    out to the line amount, and otherwise states the line amount as the
 *    price of that quantity (BT-149), so package and tiered pricing stay
 *    exact. Its Stripe discount becomes a line allowance (BG-27). A
 *    tax-inclusive line has no net unit price in Stripe at all, so its net
 *    price is the line's `taxable_amount` divided by the quantity, at 8
 *    decimals, and any discount is already inside it.
 * 2. One VAT rate per line. EN 16931 cannot express two taxes on one line, so
 *    a line with two non-zero taxes is refused rather than summed.
 * 3. Nothing is invented. A missing customer name or address reaches the
 *    validator as an empty string, which reports the exact rule (BR-07,
 *    BR-10, BR-DE-8…) instead of this file substituting a placeholder that
 *    passes.
 * 4. Stripe's own total is compared with the total the engine computes, and a
 *    difference is returned as a note. Expect one now and then: Stripe rounds
 *    VAT per line, EN 16931 once per rate, so an invoice with several lines
 *    at one rate can differ by a cent or two. The document states the
 *    EN 16931 figure, which is the one a tax authority recomputes.
 * 5. A Stripe credit note (a separate object from an invoice) maps through the
 *    same line logic, with `invoiceTypeCode: "381"` and amounts stated
 *    positively, per the engine's own convention (see `types.ts`). This
 *    assumes a credit note line carries the same `taxes` shape as an invoice
 *    line — true for every credit note this package has been tested against,
 *    but worth checking against your own Stripe API version if line items
 *    look different.
 *
 * Out of scope: invoices in more than one tax jurisdiction per line, and
 * writing the Factur-X PDF (this library reads Factur-X PDFs but does not
 * write them; `generateCii` gives you the XML a PDF/A-3 tool embeds, or see
 * `./hosted.js` for the hosted API's PDF).
 */

import {
  computeTotals,
  lineNetAmount,
  type InvoiceInput,
  type InvoiceLine,
  type Party,
  type PaymentInstructions,
  type PostalAddress,
  type PrecedingInvoiceReference,
  type Profile,
  type VatCategory,
} from "@attestwire/en16931";

// --- the Stripe subset this reads --------------------------------------------

/** A decimal as raw JSON sends it (a string) or as the SDK types it (`Decimal`). */
export type StripeDecimal = string | { toString(): string };

export interface StripeAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  state?: string | null;
  country?: string | null;
}

export interface StripeTaxRate {
  id: string;
  percentage: number;
}

export interface StripeLineTax {
  amount: number;
  /** "exclusive" or "inclusive"; typed as string because the SDK types it as an open union. */
  tax_behavior: string;
  taxability_reason: string;
  taxable_amount: number | null;
  tax_rate_details?: { tax_rate: string | StripeTaxRate } | null;
}

export interface StripeInvoiceLine {
  id: string;
  description?: string | null;
  amount: number;
  quantity?: number | null;
  quantity_decimal?: StripeDecimal | null;
  pricing?: { unit_amount_decimal?: StripeDecimal | null } | null;
  discount_amounts?: { amount: number }[] | null;
  taxes?: StripeLineTax[] | null;
  period?: { start: number; end: number } | null;
}

export interface StripeInvoice {
  id: string;
  number: string | null;
  created: number;
  status_transitions?: { finalized_at?: number | null } | null;
  due_date?: number | null;
  currency: string;
  description?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_address?: StripeAddress | null;
  customer_tax_ids?: { type: string; value: string | null }[] | null;
  /**
   * The customer's tax status as Stripe Tax saw it when the invoice was
   * finalized: `"none"`, `"exempt"` or `"reverse"`. Informational only — this
   * recipe categorises each *line* from its own `taxes[].taxability_reason`,
   * which is what Stripe Tax actually computed, and cross-checks this field
   * only to raise a note if the two disagree (see `notes`).
   */
  customer_tax_exempt?: string | null;
  lines: { data: StripeInvoiceLine[]; has_more?: boolean };
  total: number;
  /** What is still owed. Card payments, customer balance and credits have been taken off. */
  amount_remaining: number;
  metadata?: Record<string, string> | null;
}

/** A Stripe credit note line. Assumed to carry the same tax shape as an invoice line — see decision 5 above. */
export type StripeCreditNoteLine = StripeInvoiceLine;

/** A Stripe credit note: its own object, not an invoice with a negative amount. */
export interface StripeCreditNote {
  id: string;
  number: string | null;
  /** The invoice this credit note is against. Only its id — pass `precedingInvoice` in the options for BT-25/BT-26. */
  invoice?: string | null;
  created: number;
  effective_at?: number | null;
  currency: string;
  memo?: string | null;
  reason?: string | null;
  customer_name?: string | null;
  customer_email?: string | null;
  customer_address?: StripeAddress | null;
  customer_tax_ids?: { type: string; value: string | null }[] | null;
  lines: { data: StripeCreditNoteLine[]; has_more?: boolean };
  total: number;
  metadata?: Record<string, string> | null;
}

// --- options and result ------------------------------------------------------

export interface StripeMappingOptions {
  /** You, as the invoice must name you: legal name, VAT ID, address. */
  seller: Party;
  /** BG-16. XRechnung requires it (BR-DE-1); e.g. `{ meansCode: "58", iban }`. */
  payment: PaymentInstructions;
  /** Default `xrechnung-ubl`. Use `xrechnung-cii` or `facturx-en16931` for CII. */
  profile?: Profile;
  /**
   * BT-10. A German public-sector buyer's Leitweg-ID, or any reference a
   * business buyer gave you. Falls back to `metadata.buyer_reference` on the
   * Stripe invoice. XRechnung requires it (BR-DE-15).
   */
  buyerReference?: string;
  /**
   * Tax rates by ID, for when the invoice was retrieved without expanding
   * `lines.data.taxes.tax_rate_details.tax_rate`. Stripe states a line's tax
   * amount but not its percentage; the rate object does.
   */
  taxRates?: Record<string, StripeTaxRate>;
  /** BT-120 per category. Category E has no default, so an exempt line needs one (BR-E-10). */
  vatExemptionReasons?: Partial<Record<VatCategory, string>>;
  /** BT-130 for every line. Default `C62` ("one"). */
  unitCode?: string;
}

export interface StripeCreditNoteMappingOptions extends StripeMappingOptions {
  /**
   * BG-3. The invoice this credit note corrects. Not required by EN 16931 for
   * a credit note, but its absence is worth flagging
   * (`ATW-CREDIT-NOTE-NO-PRECEDING-INVOICE`, information-level) — supply the
   * original invoice's number (and, if you have it, its issue date) so an
   * auditor can trace the credit back.
   */
  precedingInvoice?: PrecedingInvoiceReference;
}

export interface StripeMappingResult {
  input: InvoiceInput;
  /** Things worth a look that are not errors, such as a cent of VAT rounding against Stripe. */
  notes: string[];
}

/** A Stripe invoice or credit note this recipe cannot turn into an EN 16931 document as it stands. */
export class StripeMappingError extends Error {
  override name = "StripeMappingError";
}

// --- helpers -----------------------------------------------------------------

const isoDate = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;
const text = (s: string | null | undefined) => (typeof s === "string" ? s.trim() : "");

/**
 * Stripe states money in the currency's minor unit: cents for EUR, but whole
 * yen for JPY. From Stripe's list of zero-decimal currencies.
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL = new Set(
  "BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF".split(" "),
);
/** Three-decimal currencies. EN 16931 amounts have at most two decimals (BR-DEC-*). */
const THREE_DECIMAL = new Set("BHD JOD KWD OMR TND".split(" "));

interface Money {
  /** An amount in minor units to the invoice's units. Stripe amounts are whole minor units. */
  amount: (minorUnits: number) => number;
  /** A price in minor units, which may carry up to 12 decimals, NOT rounded. */
  price: (minorUnits: number) => number;
  /** For messages: whole yen print as 1468, cents as 14.68. */
  format: (value: number) => string;
}

function moneyFor(currency: string): Money {
  const code = currency.toUpperCase();
  if (THREE_DECIMAL.has(code)) {
    throw new StripeMappingError(
      `${code} has three decimal places in Stripe, and EN 16931 amounts have at most two, so an ` +
        "amount like 1.234 cannot be stated exactly. This recipe does not round money for you.",
    );
  }
  const divisor = ZERO_DECIMAL.has(code) ? 1 : 100;
  return {
    amount: (minorUnits) => Math.round(minorUnits) / divisor,
    price: (minorUnits) => minorUnits / divisor,
    format: (value) => (divisor === 1 && Number.isInteger(value) ? String(value) : value.toFixed(2)),
  };
}

/**
 * Quantity and price for a line whose net amount Stripe states as `amountMinor`.
 *
 * The unit price is used only when the engine's own arithmetic (quantity ×
 * price, rounded) gives back exactly Stripe's amount. Otherwise, because of
 * package or tiered pricing, a sub-cent price, or a quantity so large that 8
 * decimals of price are not enough, the line amount is stated as the price of
 * `quantity` units (BT-149 base quantity). That is exact by construction.
 */
function priced(
  base: InvoiceLine,
  quantity: number,
  amountMinor: number,
  unitMinor: number | null,
  money: Money,
  allowances?: InvoiceLine["allowances"],
): Pick<InvoiceLine, "unitPrice" | "baseQuantity"> {
  const target = money.amount(amountMinor);
  if (quantity === 0) {
    return { unitPrice: unitMinor !== null ? round8(money.price(unitMinor)) : 0 };
  }
  const candidate = round8(money.price(unitMinor ?? amountMinor / quantity));
  // Checked WITH the line's allowances, because the engine rounds the line
  // once, after them: 3 × 0.125 − 0.38 is −0.005, which rounds to −0.01, while
  // Stripe states 0.38 − 0.38 = 0. Without them the unit price passed and the
  // line came out a cent wrong.
  const discount = (allowances ?? []).reduce((sum, a) => sum + a.amount, 0);
  const expected = (Math.round(target * 100) - Math.round(discount * 100)) / 100;
  const check = { ...base, quantity, unitPrice: candidate, allowances, charges: undefined };
  try {
    if (lineNetAmount(check) === expected) return { unitPrice: candidate };
  } catch {
    // Out of range or not finite: fall through to the exact form, and let
    // validateInput report the amount if it is still a problem.
  }
  return { unitPrice: target, baseQuantity: quantity };
}

function address(a: StripeAddress | null | undefined): PostalAddress {
  return {
    line1: text(a?.line1) || undefined,
    line2: text(a?.line2) || undefined,
    city: text(a?.city),
    postalCode: text(a?.postal_code),
    countrySubdivision: text(a?.state) || undefined,
    countryCode: text(a?.country).toUpperCase(),
  };
}

/** The buyer's VAT number: an `eu_vat` ID first, then any other `*_vat`. */
function buyerVatId(ids: { type: string; value: string | null }[] | null | undefined): string | undefined {
  const usable = (ids ?? []).filter((t) => text(t.value));
  const pick = usable.find((t) => t.type === "eu_vat") ?? usable.find((t) => t.type.endsWith("_vat"));
  return pick ? text(pick.value) : undefined;
}

function buyerFrom(source: {
  customer_name?: string | null;
  customer_email?: string | null;
  customer_address?: StripeAddress | null;
  customer_tax_ids?: { type: string; value: string | null }[] | null;
}): Party {
  const email = text(source.customer_email);
  return {
    name: text(source.customer_name),
    vatId: buyerVatId(source.customer_tax_ids),
    address: address(source.customer_address),
    // BT-49. XRechnung requires an electronic address for the buyer; an email
    // address under scheme EM is the one Stripe always has.
    electronicAddress: email ? { schemeId: "EM", value: email } : undefined,
    contact: email ? { email } : undefined,
  };
}

/**
 * Stripe's taxability reason → EN 16931's VAT category.
 *
 * Only the reasons with an unambiguous category are mapped. The rest
 * (`not_collecting`, `portion_*`, `proportionally_rated`, …) mean the line's
 * tax was split or not computed, and an EN 16931 line cannot say that.
 */
const CATEGORY_BY_REASON: Record<string, VatCategory> = {
  standard_rated: "S",
  reduced_rated: "S",
  taxable_basis_reduced: "S",
  zero_rated: "Z",
  reverse_charge: "AE",
  customer_exempt: "E",
  product_exempt: "E",
  product_exempt_holiday: "E",
  not_subject_to_tax: "O",
};

function lineTax(
  line: StripeInvoiceLine,
  n: number,
  taxRates: StripeMappingOptions["taxRates"],
): { tax: StripeLineTax; category: VatCategory; rate: number } {
  const taxes = line.taxes ?? [];
  if (taxes.length === 0) {
    throw new StripeMappingError(
      `Line ${n} (${line.id}) has no tax information. EN 16931 needs a VAT category on every line: ` +
        "enable Stripe Tax or attach tax rates, including for zero-rated and reverse-charge sales.",
    );
  }
  const charged = taxes.filter((t) => t.amount !== 0);
  if (charged.length > 1) {
    throw new StripeMappingError(
      `Line ${n} (${line.id}) carries ${charged.length} taxes. An EN 16931 invoice line has exactly one ` +
        "VAT category and rate, so it cannot be expressed. Split the item into one line per rate.",
    );
  }
  const tax = charged[0] ?? taxes[0]!;
  const category = CATEGORY_BY_REASON[tax.taxability_reason];
  if (!category) {
    throw new StripeMappingError(
      `Line ${n} (${line.id}) has taxability_reason "${tax.taxability_reason}", which has no single ` +
        "EN 16931 VAT category. Supported: " + Object.keys(CATEGORY_BY_REASON).join(", ") + ".",
    );
  }
  if (category !== "S") return { tax, category, rate: 0 };

  const ref = tax.tax_rate_details?.tax_rate;
  const rateObject = typeof ref === "string" ? taxRates?.[ref] : ref;
  if (!rateObject) {
    throw new StripeMappingError(
      `Line ${n} (${line.id}) is taxed at rate ${String(ref)}, but its percentage is not on the invoice. ` +
        'Retrieve the invoice with expand: ["lines.data.taxes.tax_rate_details.tax_rate"], or pass ' +
        "the rates as options.taxRates.",
    );
  }
  return { tax, category, rate: rateObject.percentage };
}

function mapLine(
  line: StripeInvoiceLine,
  n: number,
  opts: Pick<StripeMappingOptions, "taxRates" | "unitCode">,
  money: Money,
): InvoiceLine {
  const { tax, category, rate } = lineTax(line, n, opts.taxRates);
  const quantity = Number(String(line.quantity_decimal ?? line.quantity ?? 1));
  const discountCents = (line.discount_amounts ?? []).reduce((sum, d) => sum + d.amount, 0);

  const base: InvoiceLine = {
    id: String(n),
    description: text(line.description) || line.id,
    quantity,
    unitCode: opts.unitCode ?? "C62",
    unitPrice: 0,
    vatCategory: category,
    vatRate: rate,
    sellerItemId: line.id,
    // A subscription period ends at the instant the next one starts (Aug 6 to
    // Sep 6, 00:00). BT-135 is a calendar date, so the last second of the
    // period decides it: Sep 5.
    period: line.period
      ? {
          startDate: isoDate(line.period.start),
          endDate: isoDate(Math.max(line.period.start, line.period.end - 1)),
        }
      : undefined,
  };

  if (tax.tax_behavior === "inclusive") {
    // Stripe's price includes the tax, and EN 16931's BT-146 is net. The one
    // net figure Stripe states is taxable_amount: the line after discounts and
    // before tax. Divide that, not the gross price.
    if (tax.taxable_amount === null) {
      throw new StripeMappingError(`Line ${n} (${line.id}) is tax-inclusive but has no taxable_amount.`);
    }
    return {
      ...base,
      ...priced(base, quantity, tax.taxable_amount, null, money),
      note: discountCents
        ? `Net of a discount of ${money.format(money.amount(discountCents))} (tax-inclusive price).`
        : undefined,
    };
  }

  // Tax-exclusive: Stripe's unit amount is already net, in minor units, with
  // up to 12 decimals.
  const allowances = discountCents
    ? [{ amount: money.amount(discountCents), reason: "Discount", reasonCode: "95" }]
    : undefined;
  const unitMinor =
    line.pricing?.unit_amount_decimal != null ? Number(String(line.pricing.unit_amount_decimal)) : null;

  // line.amount is before discounts; the discount is the allowance above.
  return { ...base, ...priced(base, quantity, line.amount, unitMinor, money, allowances), allowances };
}

// --- the mappings -------------------------------------------------------------

export function stripeInvoiceToInput(invoice: StripeInvoice, opts: StripeMappingOptions): StripeMappingResult {
  if (!invoice.number) {
    throw new StripeMappingError(
      `Stripe invoice ${invoice.id} has no number: it is still a draft. Finalize it first; ` +
        "an invoice number (BT-1) is assigned at finalization.",
    );
  }
  if (invoice.lines.has_more) {
    throw new StripeMappingError(
      `Stripe invoice ${invoice.id} has more lines than the invoice object embeds. Fetch them all with ` +
        "stripe.invoices.listLineItems() and pass { ...invoice, lines: { data: allLines } }.",
    );
  }

  const buyer = buyerFrom(invoice);
  const money = moneyFor(invoice.currency);
  const lines = invoice.lines.data.map((line, i) => mapLine(line, i + 1, opts, money));

  // BT-113: everything already settled, however it was settled (card, the
  // customer's credit balance, a pre-payment credit note). Stripe's
  // amount_remaining is what is still owed after all of them.
  const settled = invoice.total - invoice.amount_remaining;
  if (settled < 0) {
    throw new StripeMappingError(
      `Stripe invoice ${invoice.number} asks for ${money.format(money.amount(invoice.amount_remaining))} but totals ` +
        `${money.format(money.amount(invoice.total))}: the difference is a previous balance the customer owes. EN 16931 has ` +
        "no place for a debt carried over from another invoice. Invoice it separately.",
    );
  }

  const input: InvoiceInput = {
    profile: opts.profile ?? "xrechnung-ubl",
    invoiceNumber: invoice.number,
    issueDate: isoDate(invoice.status_transitions?.finalized_at ?? invoice.created),
    dueDate: invoice.due_date ? isoDate(invoice.due_date) : undefined,
    currency: invoice.currency.toUpperCase(),
    note: text(invoice.description) || undefined,
    buyerReference: opts.buyerReference ?? (text(invoice.metadata?.buyer_reference) || undefined),
    seller: opts.seller,
    buyer,
    lines,
    payment: opts.payment,
    paidAmount: settled > 0 ? money.amount(settled) : undefined,
    vatExemptionReasons: opts.vatExemptionReasons,
  };

  const notes: string[] = [];
  try {
    const computed = computeTotals(input).taxInclusiveAmount;
    // Paid in full in Stripe means nothing is due, even when VAT rounding
    // makes the EN 16931 total a cent away from what was charged: state the
    // payment as the document's own total, so the amount due (BT-115) is 0.
    if (invoice.amount_remaining === 0 && settled > 0) input.paidAmount = computed;
    const stated = money.amount(invoice.total);
    if (Math.abs(computed - stated) > 0.005) {
      notes.push(
        `Stripe's total for ${invoice.number} is ${money.format(stated)} but the EN 16931 total is ` +
          `${money.format(computed)}. The document states the EN 16931 figure. A difference of a cent or ` +
          "two is VAT rounding: Stripe rounds VAT per line and, on tax-inclusive prices, takes it out of " +
          "the gross; EN 16931 computes it once per rate from the net. More than that is worth a look.",
      );
    }
  } catch {
    // An input computeTotals refuses is reported, with the rule, by validateInput.
  }

  // customer_tax_exempt is Stripe's account-level snapshot of the customer's
  // tax status; the category above came from each line's own
  // taxability_reason, which is what Stripe Tax actually computed for that
  // line. The two should agree. When Stripe marked the customer "reverse" but
  // not one line came out AE, something in the tax configuration (a tax rate
  // set up outside Stripe Tax, a product marked exempt) overrode it — worth a
  // look before the invoice goes out, so this is a note, not a refusal.
  if (invoice.customer_tax_exempt === "reverse" && !lines.some((l) => l.vatCategory === "AE")) {
    notes.push(
      `Stripe recorded this customer's tax status as "reverse" (reverse charge), but no line on invoice ` +
        `${invoice.number} came out as VAT category AE. Check the tax rates or product tax codes used on this invoice.`,
    );
  }

  return { input, notes };
}

export function stripeCreditNoteToInput(
  note: StripeCreditNote,
  opts: StripeCreditNoteMappingOptions,
): StripeMappingResult {
  if (!note.number) {
    throw new StripeMappingError(`Stripe credit note ${note.id} has no number.`);
  }
  if (note.lines.has_more) {
    throw new StripeMappingError(
      `Stripe credit note ${note.id} has more lines than the object embeds. Fetch them all and pass ` +
        "{ ...note, lines: { data: allLines } }.",
    );
  }

  const buyer = buyerFrom(note);
  const money = moneyFor(note.currency);
  const lines = note.lines.data.map((line, i) => mapLine(line, i + 1, opts, money));

  const input: InvoiceInput = {
    profile: opts.profile ?? "xrechnung-ubl",
    invoiceTypeCode: "381",
    invoiceNumber: note.number,
    issueDate: isoDate(note.effective_at ?? note.created),
    currency: note.currency.toUpperCase(),
    note: text(note.memo) || undefined,
    buyerReference: opts.buyerReference ?? (text(note.metadata?.buyer_reference) || undefined),
    precedingInvoices: opts.precedingInvoice ? [opts.precedingInvoice] : undefined,
    seller: opts.seller,
    buyer,
    lines,
    payment: opts.payment,
    vatExemptionReasons: opts.vatExemptionReasons,
  };

  const notes: string[] = [];
  try {
    const computed = computeTotals(input).taxInclusiveAmount;
    const stated = money.amount(note.total);
    if (Math.abs(computed - stated) > 0.005) {
      notes.push(
        `Stripe's total for credit note ${note.number} is ${money.format(stated)} but the EN 16931 total is ` +
          `${money.format(computed)}. The document states the EN 16931 figure; see the VAT rounding note in ` +
          "stripeInvoiceToInput for why the two can differ by a cent or two.",
      );
    }
  } catch {
    // Reported, with the rule, by validateInput.
  }

  return { input, notes };
}
