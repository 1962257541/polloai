import { describe, expect, it } from "vitest";
import { imageToVideoSchema, textToImageSchema } from "../src/contracts";

describe("shared zod schemas", () => {
  it("validates text-to-image payload", () => {
    const parsed = textToImageSchema.parse({ prompt: "a flying cat" });
    expect(parsed.size).toBe("1024x1024");
  });

  it("rejects empty text-to-image prompt", () => {
    expect(() => textToImageSchema.parse({ prompt: "" })).toThrow();
  });

  it("validates image-to-video payload", () => {
    const parsed = imageToVideoSchema.parse({
      prompt: "camera dolly in",
      imageUrl: "https://example.com/in.png",
    });
    expect(parsed.durationSec).toBe(4);
  });

  it("rejects invalid image URL", () => {
    expect(() =>
      imageToVideoSchema.parse({ prompt: "run", imageUrl: "not-url" }),
    ).toThrow();
  });
});
