import { describe, expect, it } from "vitest";
import { extractConstraintsFromPrompt, validateTaskPromptsAgainstConstraints } from "../src/lib/constraint-validator.js";

describe("constraint-validator", () => {
  describe("extractConstraintsFromPrompt", () => {
    it("extracts 'every X' patterns", () => {
      const prompt = "Every route must use the translation method. Also every user-facing string needs to be handled.";
      const constraints = extractConstraintsFromPrompt(prompt);
      expect(constraints.length).toBeGreaterThan(0);
    });

    it("extracts 'must use' patterns", () => {
      const prompt = "Every route must use your translation method for all strings.";
      const constraints = extractConstraintsFromPrompt(prompt);
      expect(constraints.some((c) => c.line.includes("must use"))).toBe(true);
    });

    it("extracts 'all' patterns", () => {
      const prompt = "All user-facing strings must be translated.";
      const constraints = extractConstraintsFromPrompt(prompt);
      expect(constraints.length).toBeGreaterThan(0);
    });

    it("returns empty when no constraints found", () => {
      const prompt = "Build a simple homepage for the website.";
      const constraints = extractConstraintsFromPrompt(prompt);
      expect(constraints).toHaveLength(0);
    });
  });

  describe("validateTaskPromptsAgainstConstraints", () => {
    it("passes when task prompts mention the constraint key phrases", () => {
      const tasks = [
        { id: "home-route", prompt: "Implement the home page. Every route must use your translation method." },
        { id: "about-route", prompt: "Implement the about page. Every route must use your translation method." },
      ];
      const constraints = extractConstraintsFromPrompt("Every route must use your translation method.");
      const result = validateTaskPromptsAgainstConstraints(tasks, constraints);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("fails when a task is missing the constraint", () => {
      const tasks = [
        { id: "home-route", prompt: "Implement the home page." },
        { id: "about-route", prompt: "Implement the about page." },
      ];
      const constraints = extractConstraintsFromPrompt("Every route must use your translation method.");
      const result = validateTaskPromptsAgainstConstraints(tasks, constraints);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.taskId === "home-route")).toBe(true);
      expect(result.violations.some((v) => v.taskId === "about-route")).toBe(true);
    });

    it("validates against the matched constraint span, not the first 80 chars of a long line", () => {
      const objective =
        "Task: Build a two-repo product (backend and frontend). All tasks must share the OpenAPI contract.";
      const constraints = extractConstraintsFromPrompt(objective);
      expect(constraints.some((c) => c.phrase.toLowerCase().startsWith("all"))).toBe(true);
      const tasks = [
        { id: "a", prompt: "Create backend. All tasks must share the OpenAPI contract." },
        { id: "b", prompt: "Create frontend only." },
      ];
      const result = validateTaskPromptsAgainstConstraints(tasks, constraints);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.taskId === "b")).toBe(true);
      expect(result.violations.some((v) => v.taskId === "a")).toBe(false);
    });

    it("passes when there are no constraints", () => {
      const tasks = [{ id: "task-1", prompt: "Just do something." }];
      const result = validateTaskPromptsAgainstConstraints(tasks, []);
      expect(result.valid).toBe(true);
    });
  });
});
