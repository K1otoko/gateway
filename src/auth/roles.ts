export const ROLES = ['super', 'admin', 'user'] as const;

export type Role = (typeof ROLES)[number];

const roleRank: Record<Role, number> = {
  super: 3,
  admin: 2,
  user: 1,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ROLES.some((role) => role === value);
}

export function roleAtLeast(actual: Role, required: Role): boolean {
  return roleRank[actual] >= roleRank[required];
}
