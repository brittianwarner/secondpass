// secondpass corpus fixture — not executed. See bench/corpus/manifest.json
//
// NEGATIVE (hard): unsafe-redirect
// The navigation target is a module-level constant defined in this
// file — never derived from a request, a query string, or any other
// caller-controlled input.

const INTERNAL_LOGOUT_PATH = "/auth/logged-out";

export function handleLogout(): void {
  location.replace(INTERNAL_LOGOUT_PATH);
}
