class HttpError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.code = errorCode;
    this.statusCode = errorCode;
  }
}

export default HttpError;
