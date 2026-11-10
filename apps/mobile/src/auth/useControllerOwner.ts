import { useEffect } from 'react';
import type { SessionController } from './SyntheticChatConnected';

// An effect replay must not destroy an authenticated injected controller. A lease
// survives only a same-controller re-setup in this microtask; real removal clears
// ephemeral state without signing the provider out or touching a replacement.
const leases = new WeakMap<SessionController, number>();
export function useControllerOwner(controller: SessionController | null) {
  useEffect(() => {
    if (!controller) return;
    leases.set(controller, (leases.get(controller) ?? 0) + 1);
    return () => {
      leases.set(controller, (leases.get(controller) ?? 1) - 1);
      void Promise.resolve().then(() => {
        if (leases.get(controller) === 0) {
          leases.delete(controller);
          controller.dispose();
        }
      });
    };
  }, [controller]);
}
