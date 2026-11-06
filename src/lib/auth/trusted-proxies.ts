import { isIP } from 'node:net';

/** Parse explicit proxy addresses; absence disables forwarding altogether. */
export function parseTrustedProxyCidrs(value: string | undefined): string[] | false {
  if (value === undefined || value.trim() === '') return false;
  return value.split(',').map(item => {
    const entry = item.trim();
    const parts = entry.split('/');
    const address = parts[0];
    const family = !address.includes('%') && isIP(address);
    if (!family || parts.length > 2) throw new Error('Invalid trusted proxy IP or CIDR');
    if (parts.length === 2) {
      const prefix = parts[1];
      const maximum = family === 4 ? 32 : 128;
      if (!/^[1-9]\d*$/.test(prefix) || Number(prefix) > maximum) throw new Error('Invalid trusted proxy prefix');
    }
    return entry;
  });
}
