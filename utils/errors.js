// Typed HTTP errors so models and controllers can throw precise status codes.
// errorHandler reads err.statusCode before its name-based mappings, so anything
// thrown from here bypasses the generic-Error -> 400 fallback.
class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

class BadRequestError extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}

class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}

class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}

class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

class ConflictError extends HttpError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}

module.exports = {
  HttpError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
};
