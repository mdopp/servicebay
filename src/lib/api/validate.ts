import { NextResponse } from 'next/server';
import { z } from 'zod';

export type ParamResult<T> =
  | { ok: true; value: T }
  | { ok: false; response: NextResponse };

export async function parseRouteParam<T>(
  paramsPromise: Promise<Record<string, string>>,
  key: string,
  schema: z.ZodType<T>,
  options: { decode?: boolean } = {},
): Promise<ParamResult<T>> {
  const params = await paramsPromise;
  const raw = params?.[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      response: NextResponse.json({ error: `missing route param: ${key}` }, { status: 400 }),
    };
  }
  let value = raw;
  if (options.decode !== false) {
    try {
      value = decodeURIComponent(raw);
    } catch {
      return {
        ok: false,
        response: NextResponse.json({ error: `invalid encoding in ${key}` }, { status: 400 }),
      };
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: `invalid ${key}` }, { status: 400 }),
    };
  }
  return { ok: true, value: result.data };
}
