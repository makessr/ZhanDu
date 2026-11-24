import { randomIdSuffix } from "../random-id";
export function createAiRequestId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${randomIdSuffix()}`;
}
