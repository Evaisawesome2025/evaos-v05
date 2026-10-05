// Shared deterministic contract; byte-identical copy in EVAOS worker/src/brief-model.js.
export const FIELDS = Object.freeze({
  objective: { label: 'Objective', min: 12, max: 600 },
  inputs: { label: 'Available inputs', min: 3, max: 2400 },
  deliverable: { label: 'Deliverable', min: 3, max: 1200 },
  constraints: { label: 'Constraints', min: 3, max: 1600 },
  success: { label: 'Success checklist', min: 3, max: 2000 },
  stopRule: { label: 'Stop rule', min: 3, max: 1000 }
});
export const NOTICE = 'A brief prepared from your words. Deterministic formatting only; no AI judgment, research, specialist assignment or execution. Checklist items are unverified.';
export function normalizeBrief(value) {
  const errors = {};
  const brief = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: { form: 'Provide a brief object.' } };
  if (Object.keys(value).some(key => !Object.hasOwn(FIELDS, key))) errors.form = 'Only the six brief fields are accepted.';
  for (const [key, field] of Object.entries(FIELDS)) {
    const raw = value[key];
    if (typeof raw !== 'string') { errors[key] = `${field.label} is required.`; continue; }
    if (raw.length > field.max) { errors[key] = `${field.label}: use at most ${field.max} characters.`; continue; }
    const text = raw.replace(/\r\n?/g, '\n').trim();
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) errors[key] = `${field.label}: remove control characters.`;
    if (text.length < field.min) errors[key] = `${field.label}: use ${field.min}–${field.max} characters.`;
    brief[key] = text;
  }
  if (typeof brief.success === 'string') {
    const lines = brief.success.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length < 1 || lines.length > 12 || lines.some(s => s.length < 3 || s.length > 240)) errors.success = 'Add 1–12 checklist items, one per line, with 3–240 characters each.';
    brief.success = lines.join('\n');
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, brief };
}
export function exportBrief(brief) {
  return ['JOINERMILL / EVAOS — WORK BRIEF', 'Status: prepared, not executed', NOTICE, '',
    ...Object.entries(FIELDS).flatMap(([key, field]) => [field.label.toUpperCase(), key === 'success' ? brief[key].split('\n').map(s => '[ ] ' + s).join('\n') : brief[key], '']),
    'End of brief. Completion requires a real deliverable and human review.', ''].join('\n');
}
export async function digestText(text) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
