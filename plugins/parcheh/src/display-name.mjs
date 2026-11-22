const pattern = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._'‘’-]{0,39}$/u;

export const invalidDisplayName = 'Use up to 40 characters. Start with a letter or number and use only letters, numbers, spaces, periods, underscores, apostrophes, or hyphens.';

export function normalizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().normalize('NFC');
  return pattern.test(name) ? name : null;
}
