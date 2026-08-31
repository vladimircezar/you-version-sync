import { describe, expect, it } from "vitest";
import { TokenStore } from "../src/auth/tokenStore";
import { OfficialApiProvider } from "../src/providers/officialApi";
import { ResilientHttp } from "../src/sync/http";
import { CAPABILITIES, capabilityFor, unavailableTypes } from "../src/providers/capabilities";
import { NO_EXPORT_MESSAGE, UserExportProvider } from "../src/providers/userExport";
import { EXPERIMENTAL_STATUS, ExperimentalProvider } from "../src/providers/experimental";
import { buildAuthorizeUrl } from "../src/auth/oauth";
import { HIGHLIGHTS_PERMISSION, SUPPORTED_SCOPES } from "../src/constants";
import { clampInterval, normalizeSettings, redirectUri } from "../src/settings";
import { MIN_AUTO_SYNC_MINUTES, scanScopeLabel } from "../src/constants";

describe("capability matrix", () => {
  it("marks highlights as the only available type", () => {
    expect(capabilityFor("highlight").state).toBe("available");
    expect(
      unavailableTypes()
        .map((c) => c.dataType)
        .sort(),
    ).toEqual(["bookmark", "note", "plan"]);
  });

  it("gives a reason for every unavailable type", () => {
    for (const capability of CAPABILITIES) {
      if (capability.state === "unavailable") expect(capability.reason.length).toBeGreaterThan(20);
    }
  });

  it("throws for an unknown data type", () => {
    expect(() => capabilityFor("nope" as never)).toThrow();
  });
});

describe("user export provider", () => {
  it("reports itself unavailable with an explanation", async () => {
    const provider = new UserExportProvider();
    const availability = await provider.availability();
    expect(availability.usable).toBe(false);
    expect(availability.reason).toBe(NO_EXPORT_MESSAGE);
    expect(availability.reason).toContain("does not currently offer");
  });

  it("supplies no highlight source", () => {
    expect(new UserExportProvider().highlights()).toBeNull();
  });

  it("refuses to pretend it parsed anything", async () => {
    await expect(
      new UserExportProvider().parseExport(new ArrayBuffer(0), "export.zip"),
    ).rejects.toThrow(/does not currently offer/);
  });
});

describe("experimental provider", () => {
  it("is inert and says so", async () => {
    const provider = new ExperimentalProvider();
    await expect(provider.availability()).resolves.toEqual({
      usable: false,
      reason: EXPERIMENTAL_STATUS,
    });
    expect(provider.highlights()).toBeNull();
    expect(EXPERIMENTAL_STATUS).toContain("Not implemented");
  });
});

describe("authorize URL", () => {
  const config = { appKey: "app-key-123", redirectUri: "http://localhost:51789/callback" };
  const params = {
    pkce: { verifier: "v".repeat(43), challenge: "challenge-value", method: "S256" as const },
    state: "state-value",
    nonce: "nonce-value",
  };

  it("sends only the supported OIDC scopes", () => {
    const url = new URL(buildAuthorizeUrl(config, params));
    expect(url.searchParams.get("scope")).toBe(SUPPORTED_SCOPES.join(" "));
  });

  it("never puts a data permission in the scope", () => {
    const url = new URL(buildAuthorizeUrl(config, params));
    expect(url.searchParams.get("scope")).not.toContain(HIGHLIGHTS_PERMISSION);
  });

  it("requests highlights via requested_permissions[]", () => {
    const url = new URL(buildAuthorizeUrl(config, params));
    expect(url.searchParams.getAll("requested_permissions[]")).toEqual([HIGHLIGHTS_PERMISSION]);
  });

  it("sends the PKCE challenge with method S256", () => {
    const url = new URL(buildAuthorizeUrl(config, params));
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("never sends the code verifier", () => {
    expect(buildAuthorizeUrl(config, params)).not.toContain(params.pkce.verifier);
  });

  it("includes state and nonce", () => {
    const url = new URL(buildAuthorizeUrl(config, params));
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
  });

  it("adds require_user_interaction only when asked", () => {
    expect(buildAuthorizeUrl(config, params)).not.toContain("require_user_interaction");
    expect(buildAuthorizeUrl(config, { ...params, requireUserInteraction: true })).toContain(
      "require_user_interaction=true",
    );
  });

  it("targets the documented authorize endpoint", () => {
    expect(buildAuthorizeUrl(config, params)).toContain(
      "https://api.youversion.com/auth/authorize",
    );
  });
});

describe("settings normalisation", () => {
  it("supplies defaults for missing values", () => {
    const s = normalizeSettings({});
    expect(s.destinationRoot).toBe("Sources/YouVersion");
    expect(s.autoSyncIntervalMinutes).toBe(0);
    expect(s.conflictPolicy).toBe("preserve");
    expect(s.removalPolicy).toBe("mark");
    expect(s.downloadVerseText).toBe(false);
  });

  it("rejects junk", () => {
    const s = normalizeSettings({ callbackPort: 80, bibleId: -5, scanBooks: "nope" } as never);
    expect(s.callbackPort).toBe(51789);
    expect(s.bibleId).toBe(3034);
    expect(s.scanBooks).toEqual([]);
  });

  it("strips slashes from the destination root", () => {
    expect(
      normalizeSettings({ destinationRoot: "/Sources/YouVersion/" } as never).destinationRoot,
    ).toBe("Sources/YouVersion");
  });

  it("floors any automatic interval at the minimum", () => {
    expect(clampInterval(5)).toBe(MIN_AUTO_SYNC_MINUTES);
    expect(clampInterval(0)).toBe(0);
    expect(clampInterval(-1)).toBe(0);
    expect(clampInterval(120)).toBe(120);
    expect(clampInterval("abc")).toBe(0);
  });

  it("builds a loopback redirect URI from the port", () => {
    expect(redirectUri(normalizeSettings({ callbackPort: 51789 } as never))).toBe(
      "http://localhost:51789/callback",
    );
  });
});

describe("permission gating", () => {
  function providerWith(grantedPermissions: string[], permissionsReported: boolean | undefined) {
    const tokens = new TokenStore({
      persistence: "session",
      save: async () => undefined,
      load: async () => null,
    });
    const stored = tokens.store({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3_600_000,
      grantedPermissions,
      permissionsReported,
    });
    const provider = new OfficialApiProvider({
      http: new ResilientHttp({
        transport: async () => ({ status: 200, headers: {}, text: "{}" }),
      }),
      oauth: {} as never,
      tokens,
      appKey: "k",
      bibleId: 3034,
      scanScope: { scope: "whole", books: [] },
      downloadVerseText: false,
    });
    return { provider, ready: stored };
  }

  it("is usable when the highlights permission was granted", async () => {
    const { provider, ready } = providerWith(["highlights"], true);
    await ready;
    await expect(provider.availability()).resolves.toMatchObject({ usable: true });
  });

  it("blocks only when YouVersion actually reported a denial", async () => {
    const { provider, ready } = providerWith([], true);
    await ready;
    const availability = await provider.availability();
    expect(availability.usable).toBe(false);
    expect(availability.reason).toMatch(/not granted/);
  });

  it("does NOT block when YouVersion reported nothing - silence is not denial", async () => {
    const { provider, ready } = providerWith([], undefined);
    await ready;
    const availability = await provider.availability();
    expect(availability.usable).toBe(true);
    expect(availability.reason).toMatch(/did not report/);
  });
});

describe("scan scope defaults and labels", () => {
  it("defaults to a complete scan, so nothing is silently skipped", () => {
    expect(normalizeSettings({}).scanScope).toBe("whole");
  });

  it("labels every scope in plain language", () => {
    expect(scanScopeLabel("whole")).toBe("the whole Bible");
    expect(scanScopeLabel("new_testament")).toContain("New Testament");
    expect(scanScopeLabel("old_testament")).toContain("Old Testament");
    expect(scanScopeLabel("books", ["JHN", "ROM"])).toContain("JHN, ROM");
    expect(scanScopeLabel("books", [])).toContain("no books selected");
  });
});
