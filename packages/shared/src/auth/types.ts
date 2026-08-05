export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  /**
   * Has this person concluded the connect-your-agent onboarding (welcome
   * page Done, or dismissing the reminder pill). Optional so pre-existing
   * fixtures and cached user objects stay valid; the server always sends it,
   * and consumers treat only an explicit `false` as "still onboarding" — an
   * absent field must never resurrect the welcome flow.
   */
  onboardingDone?: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
