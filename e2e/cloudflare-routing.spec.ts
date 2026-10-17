import { test, expect } from "@playwright/test";

test("asset routing preserves HTML security, immutable bundles and API JSON responses", async ({ request }) => {
  const document = await request.get("/");
  expect(document.status()).toBe(200);
  const headers = document.headers();
  expect(headers["content-type"]).toContain("text/html");
  expect(headers["cache-control"]).toBe("no-cache");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  expect(headers["strict-transport-security"]).toBe("max-age=31536000");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");

  const head = await request.head("/");
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  for (const key of ["content-type", "cache-control", "x-content-type-options", "x-frame-options", "content-security-policy", "strict-transport-security"]) {
    expect(head.headers()[key]).toBe(headers[key]);
  }

  const html = await document.text();
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/);
  expect(script, "built HTML must reference its actual JavaScript bundle").not.toBeNull();
  const bundle = await request.get(script![1]);
  expect(bundle.status()).toBe(200);
  expect(bundle.headers()["content-type"]).toMatch(/javascript/);
  expect(bundle.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(bundle.headers()["x-content-type-options"]).toBe("nosniff");

  // Navigation requests must not become the SPA, even for the exact /api path.
  for (const path of ["/api", "/api?source=navigation", "/api/not-an-endpoint"]) {
    const api = await request.get(path, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(api.status()).toBe(401);
    expect(api.headers()["content-type"]).toContain("application/json");
    expect(api.headers()["cache-control"]).toBe("no-store");
    expect((await api.json()).code).toBe("AUTH_REQUIRED");
  }
  const health = await request.get("/api/health", { headers: { "Sec-Fetch-Mode": "navigate" } });
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
});
