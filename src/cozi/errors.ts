export class CoziError extends Error {
  readonly statusCode?: number;
  readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = new.target.name;
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (responseData !== undefined) this.responseData = responseData;
  }
}

export class AuthenticationError extends CoziError {}
export class ValidationError extends CoziError {}
export class RateLimitError extends CoziError {}
export class APIError extends CoziError {}
export class NetworkError extends CoziError {}
export class ResourceNotFoundError extends APIError {}
export class PermissionDeniedError extends APIError {}

/**
 * A write returned a success status but the server did not apply it.
 *
 * Cozi's calendar endpoint answers 200 even when it discards an operation,
 * reporting the reason in a `rejectedItems` array in the response body. Without
 * this check a failed write looks identical to a successful one, so the caller
 * (and any LLM relaying it) reports success that never happened.
 */
export class WriteVerificationError extends APIError {}
