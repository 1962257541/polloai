import { canTransition, isTerminalStatus } from "../src/generations/state-machine";

describe("generation status state machine", () => {
  it("marks terminal states", () => {
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
  });

  it("allows queued -> running", () => {
    expect(canTransition("queued", "running")).toBe(true);
  });

  it("disallows terminal -> running", () => {
    expect(canTransition("cancelled", "running")).toBe(false);
  });
});
