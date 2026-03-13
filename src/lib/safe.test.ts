import { describe, expect, it } from "vitest";

import { buildApiUrl, buildStreamUrl, looksLikeAutofillError } from "./safe";

describe("buildApiUrl", () => {
  it("preserves query strings instead of encoding them into the pathname", () => {
    expect(buildApiUrl("http://localhost:8080", "/api/v1/jobs?limit=120")).toBe(
      "http://localhost:8080/api/v1/jobs?limit=120",
    );
  });

  it("keeps prefixed base paths and request query params intact", () => {
    expect(buildApiUrl("http://localhost:8080/platform/api", "/api/v1/jobs?limit=120&state=queued")).toBe(
      "http://localhost:8080/platform/api/v1/jobs?limit=120&state=queued",
    );
  });
});

describe("buildStreamUrl", () => {
  it("preserves request query params and appends the token separately", () => {
    expect(
      buildStreamUrl("http://localhost:8080", "/sse/events?cursor=abc", {
        token: "dev-admin-token",
      }),
    ).toBe("http://localhost:8080/sse/events?cursor=abc&token=dev-admin-token");
  });
});

describe("looksLikeAutofillError", () => {
  it("keeps genuine app crashes visible", () => {
    expect(looksLikeAutofillError(new Error("Cannot read properties of null (reading 'trim')"))).toBe(false);
    expect(looksLikeAutofillError("TypeError: jobs.includes is not a function")).toBe(false);
  });

  it("matches known extension and autofill noise", () => {
    expect(
      looksLikeAutofillError(
        "Unchecked runtime.lastError: Could not establish connection. Receiving end does not exist.",
      ),
    ).toBe(true);
    expect(looksLikeAutofillError("chrome-extension://abc/bootstrap-autofill failed")).toBe(true);
  });
});
