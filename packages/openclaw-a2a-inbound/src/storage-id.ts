export function encodeTaskStorageId(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeTaskStorageId(encodedValue: string): string | undefined {
  try {
    return Buffer.from(encodedValue, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}
