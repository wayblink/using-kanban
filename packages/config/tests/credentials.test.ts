import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  credentialFor,
  loadConfig,
  normalizeServerUrl,
  resolveConfigPath,
  readCredentials,
  removeCredential,
  resolveCredentialsPath,
  resolveTransport,
  saveCredential,
} from "../src/index.js";

function env(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ukb-credentials-"));
  return { HOME: dir, XDG_CONFIG_HOME: join(dir, "xdg") };
}

function writeConfig(environment: NodeJS.ProcessEnv, body: unknown): void {
  const path = resolveConfigPath(environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

describe("credentials", () => {
  it("saves a token 0600 and reads it back, without printing it anywhere", () => {
    const environment = env();
    saveCredential(
      environment,
      "https://board.example.com/",
      "ukb_secret_token",
    );

    const path = resolveCredentialsPath(environment);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      readCredentials(environment).servers["https://board.example.com"]?.token,
    ).toBe("ukb_secret_token");
    expect(credentialFor(environment, "https://board.example.com")).toBe(
      "ukb_secret_token",
    );
    expect(credentialFor(environment, "https://other.example.com")).toBeNull();
  });

  it("removes one server without touching the others", () => {
    const environment = env();
    saveCredential(environment, "https://a.example.com", "token-a");
    saveCredential(environment, "https://b.example.com", "token-b");
    expect(removeCredential(environment, "https://a.example.com")).toBe(true);
    expect(credentialFor(environment, "https://a.example.com")).toBeNull();
    expect(credentialFor(environment, "https://b.example.com")).toBe("token-b");
    expect(removeCredential(environment, "https://a.example.com")).toBe(false);
  });

  it("canonicalizes the server key", () => {
    expect(normalizeServerUrl(" https://board.example.com/// ")).toBe(
      "https://board.example.com",
    );
    expect(() => normalizeServerUrl("board.example.com")).toThrow(/http\(s\)/u);
  });

  it("resolves flag → environment → config for the server", () => {
    const environment = env();
    expect(resolveTransport({ env: environment })).toEqual({
      server: null,
      token: null,
    });
    expect(
      resolveTransport({
        server: "https://flag.example.com",
        env: { ...environment, UKB_SERVER: "https://env.example.com" },
        config: { server: "https://config.example.com" },
      }).server,
    ).toBe("https://flag.example.com");
    expect(
      resolveTransport({
        env: { ...environment, UKB_SERVER: "https://env.example.com" },
        config: { server: "https://config.example.com" },
      }).server,
    ).toBe("https://env.example.com");
    expect(
      resolveTransport({
        env: environment,
        config: { server: "https://config.example.com" },
      }).server,
    ).toBe("https://config.example.com");
  });

  it("resolves the token flag → environment → stored credential", () => {
    const environment = env();
    saveCredential(environment, "https://board.example.com", "stored-token");

    expect(
      resolveTransport({
        env: {
          ...environment,
          UKB_SERVER: "https://board.example.com",
          UKB_TOKEN: "env-token",
        },
      }).token,
    ).toBe("env-token");
    expect(
      resolveTransport({
        server: "https://board.example.com",
        token: "flag-token",
        env: { ...environment, UKB_TOKEN: "env-token" },
      }).token,
    ).toBe("flag-token");
    expect(
      resolveTransport({
        env: { ...environment, UKB_SERVER: "https://board.example.com" },
      }).token,
    ).toBe("stored-token");
    expect(
      resolveTransport({
        env: { ...environment, UKB_SERVER: "https://elsewhere.example.com" },
      }).token,
    ).toBeNull();
  });

  it("reads server from the config file", () => {
    const environment = env();
    const dir = join(environment.XDG_CONFIG_HOME!, "ukb");
    writeConfig(environment, { server: "https://board.example.com" });
    expect(loadConfig(environment).server).toBe("https://board.example.com");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain(
      "board.example.com",
    );
  });
});
