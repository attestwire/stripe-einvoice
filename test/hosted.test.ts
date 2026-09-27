import { describe, expect, it, vi } from "vitest";

import type { InvoiceInput } from "@attestwire/en16931";
import { minimalXRechnung } from "@attestwire/en16931";

import { FACTURX_PDF_PROFILE, HostedApiError, requestFacturXPdf } from "../src/hosted.js";

const facturxInput: InvoiceInput = { ...minimalXRechnung, profile: "facturx-en16931" };

function fakeFetch(response: { status: number; json?: unknown; body?: Uint8Array }) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => {
        if (response.json === undefined) throw new Error("not JSON");
        return response.json;
      },
      arrayBuffer: async () => (response.body ?? new Uint8Array()).buffer,
    } as unknown as Response;
  });
}

describe("requestFacturXPdf", () => {
  it("posts the invoice as JSON with a Bearer header to /v1/generate?format=pdf", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fetchMock = fakeFetch({ status: 200, body: pdfBytes });

    const result = await requestFacturXPdf(facturxInput, { apiKey: "aw_live_test123", fetch: fetchMock });

    expect(result).toEqual(pdfBytes);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.attestwire.com/v1/generate?format=pdf");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer aw_live_test123");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toMatchObject({ profile: "facturx-en16931" });
  });

  it("honours a custom origin", async () => {
    const fetchMock = fakeFetch({ status: 200, body: new Uint8Array([1]) });
    await requestFacturXPdf(facturxInput, {
      apiKey: "aw_live_test123",
      origin: "https://staging.example.com/",
      fetch: fetchMock,
    });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://staging.example.com/v1/generate?format=pdf");
  });

  it("throws HostedApiError with the status, code, message and upgrade_url on 402 plan_required", async () => {
    const fetchMock = fakeFetch({
      status: 402,
      json: {
        error: "plan_required",
        message: "The Factur-X PDF needs a paid plan.",
        docs: "https://api.attestwire.com/docs#facturx-pdf",
        upgrade_url: "https://attestwire.com/pricing",
      },
    });

    let threw: unknown;
    try {
      await requestFacturXPdf(facturxInput, { apiKey: "aw_live_free_key", fetch: fetchMock });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(HostedApiError);
    const err = threw as HostedApiError;
    expect(err.status).toBe(402);
    expect(err.code).toBe("plan_required");
    expect(err.message).toBe("The Factur-X PDF needs a paid plan.");
    expect(err.upgradeUrl).toBe("https://attestwire.com/pricing");
  });

  it("throws HostedApiError with a fallback message when the error body is not JSON", async () => {
    const fetchMock = fakeFetch({ status: 500 });
    await expect(requestFacturXPdf(facturxInput, { apiKey: "k", fetch: fetchMock })).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("refuses locally, without a network call, when the profile is not facturx-en16931", async () => {
    const fetchMock = fakeFetch({ status: 200, body: new Uint8Array() });
    const wrongProfile: InvoiceInput = { ...minimalXRechnung, profile: "xrechnung-ubl" };
    await expect(requestFacturXPdf(wrongProfile, { apiKey: "k", fetch: fetchMock })).rejects.toThrow(
      new RegExp(FACTURX_PDF_PROFILE),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses locally when apiKey is missing", async () => {
    const fetchMock = fakeFetch({ status: 200, body: new Uint8Array() });
    await expect(requestFacturXPdf(facturxInput, { apiKey: "", fetch: fetchMock })).rejects.toThrow(/apiKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
