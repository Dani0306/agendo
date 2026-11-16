import { describe, expect, it } from "vitest";
import { DONE, parseCustomerReply } from "./simulated-customer";

describe("parseCustomerReply", () => {
  it("ends the conversation on a bare [FIN] or an empty reply", () => {
    expect(parseCustomerReply("[FIN]")).toBe(DONE);
    expect(parseCustomerReply("  ")).toBe(DONE);
  });

  it("keeps a message that ends with [FIN], so the agent still hears it", () => {
    expect(parseCustomerReply("si, cambiala porfa [FIN]")).toBe("si, cambiala porfa");
  });

  it("passes an ordinary message through, trimmed", () => {
    expect(parseCustomerReply(" el martes a las 3 \n")).toBe("el martes a las 3");
  });
});
