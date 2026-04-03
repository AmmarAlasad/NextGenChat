/**
 * OpenAI Codex OAuth Provider — OAuth 2.0 Authorization Code Flow
 *
 * Extends OpenAIProvider — same API format, different auth mechanism.
 *
 * OAuth Flow:
 * 1. Admin clicks "Connect OpenAI Codex" in UI
 * 2. Backend generates OAuth authorization URL with `state` param (CSRF protection)
 * 3. User redirected to OpenAI OAuth consent screen
 * 4. OpenAI redirects back to GET /auth/oauth/codex/callback?code=...&state=...
 * 5. Backend exchanges code for access_token + refresh_token
 * 6. Tokens encrypted (AES-256-GCM) and stored in OAuthToken table
 *
 * Token lifecycle:
 * - ensureTokenFresh() called before every LLM call
 * - Checks expiresAt - 60 seconds; refreshes if needed
 * - On refresh failure: marks credentials invalid, emits error to admin channel
 *
 * Required scope: model.request (check OpenAI docs for current scope names)
 */

// TODO: Implement Codex OAuth provider
export {};
