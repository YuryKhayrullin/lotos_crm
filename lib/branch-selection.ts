export type BranchReloadTarget = {
  setBranch: (branchId: string) => void
  initialize: (force?: boolean) => unknown
}

/** One branch-selection path is shared by the header select and side sheet. */
export function selectBranchAndReload(target: BranchReloadTarget, branchId: string): void {
  target.setBranch(branchId)
  void target.initialize(true)
}
