const CONSTRAINT_PATTERNS = [
  /\bevery\s+\w+/i,
  /\ball\s+\w+/i,
  /\beach\s+\w+/i,
  /\bany\s+\w+\s+(?:must|should|has to|needs to)/i,
  /must\s+(?:use|apply|implement|follow|include|exclude)/i,
  /always\s+(?:use|apply|implement|follow)/i,
  /\bonly\s+(?:use|apply|implement)/i,
  /\bnever\s+(?:use|apply|implement)/i,
  /required\s+to/i,
  /has to\s+be/i,
];

export interface ExtractedConstraint {
  phrase: string;
  line: string;
}

export function extractConstraintsFromPrompt(prompt: string): ExtractedConstraint[] {
  const lines = prompt.split(/\n/);
  const constraints: ExtractedConstraint[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of CONSTRAINT_PATTERNS) {
      if (pattern.test(trimmed)) {
        constraints.push({ phrase: pattern.source, line: trimmed });
        break;
      }
    }
  }
  return constraints;
}

export interface ConstraintViolation {
  taskId: string;
  missingConstraint: string;
  taskPrompt: string;
}

export interface ConstraintValidationResult {
  valid: boolean;
  violations: ConstraintViolation[];
  constraints: ExtractedConstraint[];
}

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/[`'"]/g, "").replace(/\s+/g, " ");
}

function constraintKeyFromPhrase(phrase: string): string {
  return phrase.replace(/[\s\\/]+/g, " ").trim();
}

export function validateTaskPromptsAgainstConstraints(
  tasks: { id: string; prompt: string }[],
  constraints: ExtractedConstraint[],
): ConstraintValidationResult {
  if (!constraints.length) {
    return { valid: true, violations: [], constraints };
  }
  const violations: ConstraintViolation[] = [];
  for (const task of tasks) {
    const normalized = normalizePrompt(task.prompt);
    for (const constraint of constraints) {
      const key = constraintKeyFromPhrase(constraint.phrase);
      const keyNormalized = normalizePrompt(key);
      if (!normalized.includes(keyNormalized) && !normalized.includes(constraint.line.toLowerCase().slice(0, 80))) {
        violations.push({
          taskId: task.id,
          missingConstraint: constraint.line.slice(0, 200),
          taskPrompt: task.prompt.slice(0, 100),
        });
      }
    }
  }
  return { valid: violations.length === 0, violations, constraints };
}
