import type { ProfileOwnershipLease, ProfileOwnershipPhase } from './types.js';

const PRIVATE_HANDOFF_PHASES = new Set<ProfileOwnershipPhase>([
  'close_requested',
  'process_exited',
  'profile_unlocked',
  'human_input',
]);

export function profileOwnershipRetainsPrivateHandoff(
  lease: ProfileOwnershipLease | null,
): boolean {
  return lease !== null
    && (
      lease.controlMode === 'human_handoff'
      || PRIVATE_HANDOFF_PHASES.has(lease.phase)
    );
}
