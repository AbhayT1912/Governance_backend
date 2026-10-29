export function isGovernanceAdmin(actorId: string, adminIds: string[]) {
  return adminIds.includes(actorId);
}

export function ownsGovernanceResource(ownerId: string | undefined, actorId: string) {
  return Boolean(ownerId && actorId && ownerId === actorId);
}
