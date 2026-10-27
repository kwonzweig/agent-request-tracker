// Auxiliary Decision links do not change the choice the user saw. Everything
// else remains conservative, including blocker conditions and action targets.
function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

export function actionVersionChanged(collection, before, after) {
  if (!before || !after || collection !== 'decisions') return !sameValue(before, after);
  const semantic = record => Object.fromEntries(Object.entries(record).filter(([key]) =>
    !['urls', 'last_changed_turn'].includes(key)));
  return !sameValue(semantic(before), semantic(after));
}