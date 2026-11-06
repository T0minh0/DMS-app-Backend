export function validNewPassword(password: string, role: 'worker' | 'manager'): boolean {
  if (role !== 'worker' || !/^\d+$/.test(password)) return password.length >= 6;
  if (!/^\d{8}$/.test(password) || /^(\d)\1{7}$/.test(password)) return false;
  const steps = [...password].slice(1).map((digit, i) => Number(digit) - Number(password[i]));
  return !steps.every(step => step === 1) && !steps.every(step => step === -1);
}
