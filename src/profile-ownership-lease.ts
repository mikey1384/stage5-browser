export { ProfileOwnershipLeaseController } from './profile-ownership/controller.js';
export { inspectProfileOwnershipLease } from './profile-ownership/inspection.js';
export { observeLaunchedBrowserProcess, ownershipProfileUnlocked, descendantProcessIds, snapshotOwnedDescendants, terminateProvenOrphan } from './profile-ownership/observation.js';
export { profileOwnershipRetainsPrivateHandoff } from './profile-ownership/private-handoff.js';
export { executableFingerprint, processExecutablePath, processStartedAtToken } from './profile-ownership/process.js';
export { claimProfileOwnershipLease, profileOwnershipLeasePath, profilePathFingerprint, readProfileOwnershipLease, removeProfileOwnershipLease, writeProfileOwnershipLease } from './profile-ownership/store.js';
export type { OwnedProcessObservation, ProcessTableEntry, ProfileOwnershipControlMode, ProfileOwnershipDependencies, ProfileOwnershipLease, ProfileOwnershipLeaseInspection, ProfileOwnershipPhase } from './profile-ownership/types.js';
