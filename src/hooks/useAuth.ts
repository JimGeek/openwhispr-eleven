import { useEffect, useRef } from "react";
import { authClient, isWithinGracePeriod } from "../lib/auth";
import logger from "../utils/logger";
import { useSettingsStore } from "../stores/settingsStore";

const useStaticSession = () => ({
  data: null,
  isPending: false,
  error: null,
  refetch: async () => null,
});

export function useAuth() {
  const useSession = authClient?.useSession ?? useStaticSession;
  const { data: session, isPending } = useSession();
  const user = session?.user ?? null;
  const rawIsSignedIn = Boolean(user);
  const gracePeriodActive = isWithinGracePeriod();

  // Whispr is a local BYOK app — no cloud account. Force signed-out so all account /
  // usage / referral / plans UI collapses to the logged-out branch and transcription
  // always uses the user's own API keys. (Auth code kept intact for easy revert.)
  const isSignedIn = false;
  void rawIsSignedIn;
  void gracePeriodActive;

  const lastSyncedRef = useRef(false);

  useEffect(() => {
    if (!isPending && isSignedIn && !lastSyncedRef.current) {
      logger.debug(
        "Auth state sync",
        { isSignedIn, rawIsSignedIn, gracePeriod: gracePeriodActive },
        "auth"
      );
      useSettingsStore.getState().setIsSignedIn(true);
      lastSyncedRef.current = true;
    }
  }, [isSignedIn, rawIsSignedIn, gracePeriodActive, isPending]);

  return {
    isSignedIn,
    isGracePeriodOnly: !rawIsSignedIn && gracePeriodActive,
    isLoaded: !isPending,
    session,
    user,
  };
}
