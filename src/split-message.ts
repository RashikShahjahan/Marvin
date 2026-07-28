function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function preferredBoundary(source: string, start: number, hardEnd: number): number {
  const window = source.slice(start, hardEnd);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0) {
    return start + paragraph + 2;
  }

  const newline = window.lastIndexOf("\n");
  if (newline >= 0) {
    return start + newline + 1;
  }

  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(window[index]!)) {
      return start + index + 1;
    }
  }

  return hardEnd;
}

export function splitMessage(source: string, limit = 2_000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new RangeError("limit must be a safe integer of at least 2");
  }
  if (source.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < source.length) {
    let hardEnd = Math.min(start + limit, source.length);
    if (
      hardEnd < source.length &&
      isHighSurrogate(source.charCodeAt(hardEnd - 1)) &&
      isLowSurrogate(source.charCodeAt(hardEnd))
    ) {
      hardEnd -= 1;
    }

    const end = hardEnd === source.length ? hardEnd : preferredBoundary(source, start, hardEnd);
    const safeEnd = end > start ? end : hardEnd;
    chunks.push(source.slice(start, safeEnd));
    start = safeEnd;
  }

  return chunks;
}
