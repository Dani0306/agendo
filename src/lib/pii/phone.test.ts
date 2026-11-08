import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPhone, encryptPhone, hashPhone, loadPiiSecrets, normalizePhone } from "./phone";

const PHONE = "+573000000001";
const key = randomBytes(32);

describe("hashPhone", () => {
  it("matches a value computed independently with openssl", () => {
    // printf '+573000000001' | openssl dgst -sha256 -hmac 'test-pepper'
    expect(hashPhone(PHONE, "test-pepper")).toBe("bcaabd6de87ae8c0e624e460ae85d2e27320c9fd825c95161c1dbd1937db4603");
  });

  it("is the same for every way the number can arrive", () => {
    expect(hashPhone("whatsapp:+573000000001", "p")).toBe(hashPhone(PHONE, "p"));
    expect(hashPhone("+57 300 000 0001", "p")).toBe(hashPhone(PHONE, "p"));
  });

  it("changes with the pepper", () => {
    expect(hashPhone(PHONE, "pepper-one")).not.toBe(hashPhone(PHONE, "pepper-two"));
  });
});

describe("encryptPhone", () => {
  it("round-trips, normalised", () => {
    expect(decryptPhone(encryptPhone("whatsapp:+573000000001", key), key)).toBe(PHONE);
  });

  it("produces a different ciphertext each time and never the plain number", () => {
    const first = encryptPhone(PHONE, key);
    expect(first).not.toBe(encryptPhone(PHONE, key));
    expect(first).not.toContain(PHONE);
  });

  it("refuses a tampered ciphertext", () => {
    const parts = encryptPhone(PHONE, key).split(":");
    const bytes = Buffer.from(parts[3], "base64");
    bytes[0] ^= 1;
    parts[3] = bytes.toString("base64");
    expect(() => decryptPhone(parts.join(":"), key)).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => decryptPhone(encryptPhone(PHONE, key), randomBytes(32))).toThrow();
  });

  it("refuses an unknown format", () => {
    expect(() => decryptPhone("plain-text", key)).toThrow("Unrecognised");
  });
});

describe("normalizePhone and loadPiiSecrets", () => {
  it("drops the prefix and separators", () => {
    expect(normalizePhone("whatsapp:+57 (300) 000-0001")).toBe(PHONE);
  });

  const valid = {
    PHONE_HASH_PEPPER: "x".repeat(32),
    PHONE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };

  it("loads valid secrets", () => {
    expect(loadPiiSecrets(valid).encryptionKey).toHaveLength(32);
  });

  it("throws when a secret is missing", () => {
    expect(() => loadPiiSecrets({ PHONE_HASH_PEPPER: valid.PHONE_HASH_PEPPER })).toThrow();
  });

  it("throws on a key of the wrong size", () => {
    expect(() => loadPiiSecrets({ ...valid, PHONE_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow();
  });
});
