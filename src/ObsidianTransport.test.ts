import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { ObsidianTransport } from "./ObsidianTransport";

vi.mock("obsidian");

describe("ObsidianTransport", () => {
  let transport: ObsidianTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      json: {},
      text: "{}",
      arrayBuffer: new ArrayBuffer(0),
    } as Awaited<ReturnType<typeof requestUrl>>);
    transport = new ObsidianTransport();
  });

  it("forwards timeoutMs to requestUrl when provided", async () => {
    await transport.request({ url: "http://test.com", timeoutMs: 45000 });

    expect(vi.mocked(requestUrl)).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 45000 })
    );
  });

  it("uses no timeout when timeoutMs not provided", async () => {
    await transport.request({ url: "http://test.com" });

    // When timeoutMs is absent, timeout should not be set (undefined or absent)
    const callArg = vi.mocked(requestUrl).mock.calls[0][0];
    expect(callArg).not.toHaveProperty("timeout");
  });
});
