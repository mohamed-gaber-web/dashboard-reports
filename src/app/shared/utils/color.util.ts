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

/** The band a chart mark must sit in to read on BOTH the light and dark surface. */
const CHART_L = { min: 0.42, max: 0.68, target: 0.47 } as const;
/** Below this, a fill reads as gray and stops carrying identity. */
const CHART_S = { min: 0.45, max: 0.72 } as const;

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === rn
      ? ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
      : max === gn
        ? ((bn - rn) / d + 2) * 60
        : ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return toHex({ r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 });
}

/**
 * Nudge a brand colour into the band where it works as a chart fill, keeping its
 * hue — the identity — untouched.
 *
 * A brand colour is chosen to be read as large type on white; a chart slice is a
 * thin arc read against white AND against the dark surface. The default navy
 * (#002559, lightness 0.17) is a good brand and an unusable slice: it disappears
 * into the dark canvas. Lightening it via {@link buildScale} is not the fix —
 * mixing toward white strips the chroma too, and a gray slice carries no identity
 * at all (the 400 step measures 0.07 chroma, well under the floor).
 *
 * So: correct lightness and saturation in HSL, leave hue alone. A colour already
 * in band (the default accent orange) comes back untouched — this only rescues
 * the ones that would otherwise be invisible or gray.
 */
export function chartHue(hex: string): string {
  const { h, s, l } = rgbToHsl(hexToRgb(hex));
  if (l >= CHART_L.min && l <= CHART_L.max && s >= CHART_S.min) return normalizeHexValue(hex);
  const targetL = l < CHART_L.min ? CHART_L.target : Math.min(l, CHART_L.max);
  return hslToHex(h, Math.min(Math.max(s, CHART_S.min), CHART_S.max), targetL);
}

function normalizeHexValue(hex: string): string {
  return toHex(hexToRgb(hex));
}

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
