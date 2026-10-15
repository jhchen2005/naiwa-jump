import { CONFIG } from './config.js';

// Cosmetic releases do not split the board. Bump physicsRevision only when
// physics/generation/scoring code changes comparability; settings are hashed.
export function rulesDescription(config = CONFIG) {
  const { width, step, player, camera, generation, difficulty, items } = config;
  return { physicsRevision: 1, metresPerPixel: 0.1, width, step, player, camera, generation,
    difficulty: difficulty.map(({ name, ...values }) => values), items };
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function rulesHash() {
  const bytes = new TextEncoder().encode(canonical(rulesDescription()));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
