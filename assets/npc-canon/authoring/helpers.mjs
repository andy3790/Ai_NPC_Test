// Authored source data. Run ../build.mjs to emit runtime JSON and the local catalog.
export function character(id, name, role, age, appearance, profile) {
  return { id, name, role, age, appearance, ...profile };
}
export function facts(prefix, entries) {
  return entries.map((text, i) => ({ id: `${prefix}-W${String(i + 1).padStart(2, '0')}`, visibility: 'public', text }));
}
