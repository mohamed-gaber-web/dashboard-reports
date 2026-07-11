/** Pure colour helpers for deriving a palette from a single brand colour. */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb` or `#rrggbb` into an {r,g,b} triple. */
export function hexToRgb(hex: string): Rgb {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const int = parseInt(value, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function toHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return '#' + [r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('');
}

/** True for a syntactically valid `#rgb` / `#rrggbb` colour. */
export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim());
}

/** Mix `hex` toward `target` by `amount` (0–1). */
export function mix(hex: string, target: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

export const lighten = (hex: string, amount: number) => mix(hex, '#ffffff', amount);
export const darken = (hex: string, amount: number) => mix(hex, '#000000', amount);

/**
 * Build a 50–900 tonal scale from a single base colour (treated as the 600 step).
 * Approximate but visually consistent — good enough for runtime re-theming.
 */
export function buildScale(base: string): Record<string, string> {
  return {
    '50': lighten(base, 0.9),
    '100': lighten(base, 0.8),
    '200': lighten(base, 0.62),
    '300': lighten(base, 0.45),
    '400': lighten(base, 0.28),
    '500': lighten(base, 0.12),
    '600': base,
    '700': darken(base, 0.18),
    '800': darken(base, 0.32),
    '900': darken(base, 0.5),
  };
}
