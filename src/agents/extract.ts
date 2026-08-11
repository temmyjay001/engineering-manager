import type { z } from 'zod';

function sliceLastObject(text: string): string | null {
  const end = text.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

function sanitize(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

export function extractJson(text: string): unknown {
  const fenced: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) if (m[1]) fenced.push(m[1]);
  const braced = sliceLastObject(text);
  const candidates = [...fenced.reverse(), ...(braced ? [braced] : [])];
  for (const c of candidates) {
    for (const v of [c, sanitize(c)]) {
      try {
        return JSON.parse(v);
      } catch {
        /* try next candidate */
      }
    }
  }
  throw new Error('No parseable JSON block found in agent output');
}

export function contractInstructions(schema: Record<string, unknown>, stern = false): string {
  return [
    '',
    '---',
    stern
      ? 'IMPORTANT: your previous reply did not end with a valid structured result. This time you MUST comply exactly.'
      : '',
    'When you are completely done, end your final reply with a single fenced ```json code block containing exactly one object that conforms to this JSON Schema:',
    JSON.stringify(schema),
    'Do not place any other fenced json block after it.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function parseContract<T>(text: string, contract: z.ZodType<T>): T {
  return contract.parse(extractJson(text));
}
