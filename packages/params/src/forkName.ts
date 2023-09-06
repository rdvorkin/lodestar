/**
 * Fork code name in order of occurrence
 */
export enum ForkName {
  phase0 = "phase0",
  altair = "altair",
  bellatrix = "bellatrix",
  capella = "capella",
  deneb = "deneb",
  verge = "verge",
}

/**
 * Fork sequence number in order of occurrence
 */
export enum ForkSeq {
  phase0 = 0,
  altair = 1,
  bellatrix = 2,
  capella = 3,
  // Verge is scheduled after capella for now
  verge = 4,
  deneb = 5,
}

export type ForkLightClient = Exclude<ForkName, ForkName.phase0>;
export function isForkLightClient(fork: ForkName): fork is ForkLightClient {
  return fork !== ForkName.phase0;
}

export type ForkExecution = Exclude<ForkLightClient, ForkName.altair>;
export function isForkExecution(fork: ForkName): fork is ForkExecution {
  return isForkLightClient(fork) && fork !== ForkName.altair;
}

export type ForkWithdrawals = Exclude<ForkExecution, ForkName.bellatrix>;
export function isForkWithdrawals(fork: ForkName): fork is ForkWithdrawals {
  return isForkExecution(fork) && fork !== ForkName.bellatrix;
}

// Verge is right now scheduled after capella
export type ForkVerge = Exclude<ForkWithdrawals, ForkName.capella>;
export function isForkVerge(fork: ForkName): fork is ForkBlobs {
  return isForkWithdrawals(fork) && fork !== ForkName.capella;
}

export type ForkBlobs = Exclude<ForkWithdrawals, ForkName.capella>;
export function isForkBlobs(fork: ForkName): fork is ForkBlobs {
  return isForkWithdrawals(fork) && fork !== ForkName.verge;
}
