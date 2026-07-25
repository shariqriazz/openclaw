/** Abort reason used only to replace an in-flight model request within one agent run. */
export class ActiveTurnRedirectError extends Error {
  readonly code = "active_turn_redirect";

  constructor() {
    super("Active model request redirected");
    this.name = "ActiveTurnRedirectError";
  }
}

export function isActiveTurnRedirect(error: unknown): error is ActiveTurnRedirectError {
  return (
    error instanceof ActiveTurnRedirectError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "active_turn_redirect")
  );
}
