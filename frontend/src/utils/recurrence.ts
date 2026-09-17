export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export function rulePart(parts: string, key: string): string {
  return parts.split(';').find(p => p.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
}
export function changeRuleParts(parts: string, changes: Record<string, string | null>): string {
  const kept = parts.split(';').filter(p => p && !(p.split('=')[0] in changes));
  return [...kept, ...Object.entries(changes).filter(([,v]) => v != null && v !== '').map(([k,v]) => `${k}=${v}`)].join(';');
}
export function monthlyMode(parts: string): 'date' | 'weekday' | 'custom' {
  const day = rulePart(parts, 'BYDAY');
  const date = rulePart(parts, 'BYMONTHDAY');
  if (rulePart(parts, 'BYSETPOS')) return 'custom';
  if (/^(?:[1-4]|-1)(MO|TU|WE|TH|FR|SA|SU)$/.test(day) && !date) return 'weekday';
  if (!day && (!date || /^(?:[1-9]|[12]\d|3[01])$/.test(date))) return 'date';
  return 'custom';
}
