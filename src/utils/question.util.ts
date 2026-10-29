export const sanitizeQuestion = (question: string): string => {
  if (!question || typeof question !== "string") {
    throw new Error("Question is required");
  }

  const trimmed = question.trim();

  if (trimmed.length < 3) {
    throw new Error("Question too short");
  }

  if (trimmed.length > 1000) {
    throw new Error("Question too long");
  }

  return trimmed;
};