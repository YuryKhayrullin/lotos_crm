type TrainerProfile = { id: string; name: string; branchId: string | number; userId?: string }
type TrainerAccount = { id: string; username: string; branchId: string | null; status: string }

// Explicit userId is the only identity link. Login-only approved trainers are
// valid lesson choices too; never merge people just because names match.
export function trainerOptions(
  profiles: readonly TrainerProfile[],
  accounts: readonly TrainerAccount[],
  branchId: string,
) {
  const options = profiles
    .filter((profile) => String(profile.branchId) === branchId)
    .map((profile) => ({
      value: 'profile:' + profile.id,
      name: profile.name,
      label: profile.name,
    }))
  for (const account of accounts) {
    if (account.status !== 'Активен' || account.branchId !== branchId) continue
    if (profiles.some((profile) => profile.userId === account.id && String(profile.branchId) === branchId)) continue
    options.push({ value: 'account:' + account.id, name: account.username, label: account.username + ' · логин' })
  }
  return options.sort((left, right) => left.label.localeCompare(right.label, 'ru'))
}
