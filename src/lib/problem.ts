import type { Dictionary } from './i18n';
import type { Problem } from './types';

/** Reads an API answer: the JSON body, or a problem with a message for the shopper. */
export async function readJson<T>(
  res: Response,
  t: Dictionary,
): Promise<{ ok: true; data: T } | { ok: false; problem: Problem }> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, data: body as T };
  const problem = (body && typeof body === 'object' ? body : {}) as Partial<Problem>;
  return {
    ok: false,
    problem: {
      ...problem,
      status: res.status,
      code: problem.code ?? 'error',
      detail: res.status === 429 ? t.tooMany : (problem.detail ?? t.tryAgain),
    } as Problem,
  };
}

export function fieldErrors(problem: Problem): Record<string, string> {
  return Object.fromEntries((problem.errors ?? []).map((e) => [e.path, e.message]));
}
