/**
 * Mapeia o campo `Workers.userType` (Char(1)) para um literal de papel exposto na API.
 *
 * Ver [[Regras de Negocio]] no vault — o banco usa varios codigos legados para
 * gerentes (`0`, `M`, `A`) e catadores (`1`, `W`, `C`). Comparacoes sao
 * case-insensitive porque o codigo legado mistura maiusculas/minusculas.
 */
export type UserRole = "manager" | "worker";

const MANAGER_CODES = new Set(["0", "M", "A"]);
const WORKER_CODES = new Set(["1", "W", "C"]);

export function mapUserTypeToRole(userType: string | null | undefined): UserRole {
  const code = (userType ?? "").trim().toUpperCase();

  if (MANAGER_CODES.has(code)) {
    return "manager";
  }

  if (WORKER_CODES.has(code)) {
    return "worker";
  }

  // Padrao defensivo: tratamos codigos desconhecidos como `worker`, o caminho
  // restrito — gestores precisam de codigo reconhecido para serem promovidos.
  return "worker";
}

export function isManagerRole(role: UserRole | string | null | undefined): boolean {
  return role === "manager";
}

export function isWorkerRole(role: UserRole | string | null | undefined): boolean {
  return role === "worker";
}
