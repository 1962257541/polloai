import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CreateImageDto } from "../src/generations/dto/create-image.dto";
import { CreateVideoFromImageDto } from "../src/generations/dto/create-video-from-image.dto";

describe("DTO validation", () => {
  it("validates create image dto", () => {
    const dto = plainToInstance(CreateImageDto, { prompt: "hello" });
    const errors = validateSync(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects invalid duration", () => {
    const dto = plainToInstance(CreateVideoFromImageDto, {
      prompt: "camera move",
      imageUrl: "https://example.com/a.png",
      durationSec: 20,
    });
    const errors = validateSync(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
