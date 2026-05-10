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
