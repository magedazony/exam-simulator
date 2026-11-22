// Shared HTTP types and errors for the API route modules.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: Array<{ field: string; message: string }> | undefined;
  constructor(status: number, code: string, title: string, errors?: Array<{ field: string; message: string }>) {
    super(title);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

export const invalid = (field: string, message: string): HttpError =>
  new HttpError(422, 'validation_failed', 'The request is not valid', [{ field, message }]);
export const invalidMany = (errors: Array<{ field: string; message: string }>): HttpError =>
  new HttpError(422, 'validation_failed', 'The request is not valid', errors);
export const notFound = (): HttpError => new HttpError(404, 'not_found', 'Not found');

export interface Claims {
  sub: string;
  sid: string;
  roles: string[];
  exp: number;
  mfa?: boolean;
}

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  claims: Claims;
  /** Roles read from the database for staff routes; token roles otherwise. */
  roles: string[];
  language: 'en' | 'ar';
  ip: string;
}

export type Reply = {
  status: number;
  body?: unknown;
  /** Binary response (exhibit images). Sent as is, with these headers. */
  raw?: { bytes: Buffer; contentType: string; headers?: Record<string, string> };
};
export type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

export interface RouteOptions {
  auth?: boolean;
  limited?: boolean;
  /** Staff routes: the caller needs one of these roles and a two-factor session. */
  staff?: string[];
  /** A larger request-body limit for this route (uploads). */
  maxBodyBytes?: number;
}
