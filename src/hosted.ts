/**
 * Optional: the hosted Attestwire API's Factur-X / ZUGFeRD PDF (EN 16931
 * profile), for when you want the human-readable PDF and not just the CII XML
 * `generateCii` already gives you locally for free.
 *
 * This is the ONLY thing in this package that makes a network call, and only
 * when you call this function with an API key. Everything else —
 * `stripeInvoiceToInput`, `stripeCreditNoteToInput`, `stripeInvoiceToXml`,
 * `invoiceFinalizedEventToXml` — runs entirely against the local
 * `@attestwire/en16931` engine.
 *
 * `POST /v1/generate?format=pdf` is a paid-plan feature (see the API docs at
 * https://api.attestwire.com/docs#facturx-pdf) and only ever accepts the
 * `facturx-en16931` profile — the only profile a Factur-X PDF can carry. It
 * validates first and returns `422` with the same findings `validateInput`
 * would, so calling `validateInput` yourself first (as `stripeInvoiceToXml`
 * does) is the fast, free way to catch a bad invoice before spending the
 * network round trip.
 */

import type { InvoiceInput } from "@attestwire/en16931";

export const DEFAULT_HOSTED_API_ORIGIN = "https://api.attestwire.com";

/** The only profile `?format=pdf` accepts — matches the API's own `FACTURX_PDF_PROFILE`. */
export const FACTURX_PDF_PROFILE = "facturx-en16931";

export interface HostedPdfOptions {
  /** Your Attestwire API key (`aw_live_...` / `aw_test_...`). Get one free at `POST /v1/keys`. */
  apiKey: string;
  /** Default `https://api.attestwire.com`. Override for a self-hosted or staging deployment. */
  origin?: string;
  /** Injectable for tests, or a runtime with no global `fetch`. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * The hosted API's error envelope: `{ error, message, docs, ...extra }`, as
 * documented at https://api.attestwire.com/docs.
 */
export class HostedApiError extends Error {
  override name = "HostedApiError";
  readonly status: number;
  readonly code: string;
  readonly docs?: string;
  /** Present on `402 plan_required`: where a human upgrades the plan. */
  readonly upgradeUrl?: string;

  constructor(status: number, code: string, message: string, options: { docs?: string; upgradeUrl?: string } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.docs = options.docs;
    this.upgradeUrl = options.upgradeUrl;
  }
}

/**
 * `POST {origin}/v1/generate?format=pdf` with `input` as the JSON body and
 * your API key as `Authorization: Bearer`. Resolves to the PDF's raw bytes on
 * `200`; throws `HostedApiError` on anything else (`401` unknown/revoked key,
 * `402` the PDF needs a paid plan, `413` too large, `422` the invoice fails
 * validation, `429` rate limited).
 *
 * Refuses locally, before any network call, when `input.profile` is not
 * `facturx-en16931` — the API would refuse it too (`400 unsupported_profile`),
 * but there is no reason to spend the round trip finding that out.
 */
export async function requestFacturXPdf(input: InvoiceInput, options: HostedPdfOptions): Promise<Uint8Array> {
  if (!options.apiKey) {
    throw new Error(
      "requestFacturXPdf needs options.apiKey — an Attestwire API key. Get one free with POST /v1/keys " +
        "(see https://api.attestwire.com/docs#auth).",
    );
  }
  if (input.profile !== FACTURX_PDF_PROFILE) {
    throw new Error(
      `requestFacturXPdf only ever gets a PDF for profile "${FACTURX_PDF_PROFILE}" — the only profile a ` +
        `Factur-X PDF can carry. This invoice has profile "${input.profile}"; generate its XML locally with ` +
        "generateXRechnungUBL/generateCii instead, or build a second InvoiceInput with profile " +
        `"${FACTURX_PDF_PROFILE}" for the PDF.`,
    );
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) {
    throw new Error(
      "No fetch function available. Pass options.fetch, or run on Node 18+ (or another runtime with a global fetch).",
    );
  }

  const origin = (options.origin ?? DEFAULT_HOSTED_API_ORIGIN).replace(/\/+$/, "");
  const response = await doFetch(`${origin}/v1/generate?format=pdf`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    let body: { error?: string; message?: string; docs?: string; upgrade_url?: string } | undefined;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // A non-JSON error body (an upstream 5xx from in front of the API, say).
    }
    throw new HostedApiError(
      response.status,
      body?.error ?? "unknown_error",
      body?.message ?? `POST ${origin}/v1/generate?format=pdf failed with HTTP ${response.status}.`,
      { docs: body?.docs, upgradeUrl: body?.upgrade_url },
    );
  }

  return new Uint8Array(await response.arrayBuffer());
}
