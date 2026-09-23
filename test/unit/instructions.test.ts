import { describe, expect, it } from "vitest";
import { validateConfig, type RouterConfig } from "../../src/router/config";
import { stripDelegateInstructions } from "../../src/router/instructions";

const cfg: RouterConfig = {
  activePreset: "test",
  presets: { test: { fast: { model: "test/model" } } },
  rules: [],
  defaultTier: "fast",
};
const globalBlock = "Instructions from: C:\\Users\\user\\CLAUDE.md\nDelegate everything";
const localBlock = "Instructions from: D:\\git\\proj\\AGENTS.md\nCoding conventions";

describe("stripDelegateInstructions", () => {
  it("keep leaves the array and all contents identical", () => {
    const system = ["provider", globalBlock, localBlock, "unrelated"];
    const output = { system };
    stripDelegateInstructions(output, { ...cfg, delegateInstructions: "keep" }, "D:/git/proj");
    expect(output.system).toBe(system);
    expect(output.system).toEqual(["provider", globalBlock, localBlock, "unrelated"]);
  });

  it("removes standalone global entries but preserves unrelated entries", () => {
    const output = { system: ["provider", globalBlock, "unrelated"] };
    stripDelegateInstructions(output, cfg, "D:/git/proj");
    expect(output.system).toEqual(["provider", "unrelated"]);
  });

  it.each(["\n", "\r\n"])("filters embedded sections preserving surrounding retained text (%j)", (newline) => {
    const output = { system: [["provider", globalBlock, localBlock].join("\n").replace(/\n/g, newline)] };
    stripDelegateInstructions(output, cfg, "D:/git/proj");
    expect(output.system).toEqual([`provider${newline}${localBlock.replace(/\n/g, newline)}`]);
  });

  it("strip-global keeps local blocks and removes outside blocks", () => {
    const output = { system: [globalBlock, localBlock] };
    stripDelegateInstructions(output, { ...cfg, delegateInstructions: "strip-global" }, "D:/git/proj");
    expect(output.system).toEqual([localBlock]);
  });

  it("strip-all removes local and global blocks and whitespace-only remnants", () => {
    const output = { system: [globalBlock, localBlock, ` \n${localBlock}`, "provider"] };
    stripDelegateInstructions(output, { ...cfg, delegateInstructions: "strip-all" }, "D:/git/proj");
    expect(output.system).toEqual(["provider"]);
  });

  it.each(["d:/GIT/PROJ", "D:\\git\\proj\\"])("normalizes case and separators (%s)", (project) => {
    const output = { system: [localBlock] };
    stripDelegateInstructions(output, cfg, project);
    expect(output.system).toEqual([localBlock]);
  });

  it("does not treat a sibling sharing the project prefix as local", () => {
    const output = { system: ["Instructions from: D:\\git\\project-other\\AGENTS.md\nOther"] };
    stripDelegateInstructions(output, cfg, "D:\\git\\project");
    expect(output.system).toEqual([]);
  });

  it.each([undefined, ""])("strips all blocks without a project (%j)", (project) => {
    const output = { system: [globalBlock, localBlock] };
    stripDelegateInstructions(output, cfg, project);
    expect(output.system).toEqual([]);
  });

  it("leaves empty and pathless malformed entries alone without throwing", () => {
    const system = ["", "Instructions from: ", "Instructions from:\nnot a path"];
    const output = { system: [...system] };
    expect(() => stripDelegateInstructions(output, cfg, undefined)).not.toThrow();
    expect(output.system).toEqual(system);
  });
});

describe("delegateInstructions config validation", () => {
  it.each([undefined, "keep", "strip-global", "strip-all"])("accepts %j", (policy) => {
    expect(() => validateConfig({ ...cfg, delegateInstructions: policy })).not.toThrow();
  });
  it.each([null, "strip", "", true, 1, {}, []])("rejects %j", (policy) => {
    expect(() => validateConfig({ ...cfg, delegateInstructions: policy })).toThrow(
      "tiers.json: 'delegateInstructions' must be one of strip-global|strip-all|keep",
    );
  });
});
