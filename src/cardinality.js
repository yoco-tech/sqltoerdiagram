
export function relationCardinality(rel, byKey) {
  const fromT = byKey.get(rel.fromTable.toLowerCase());
  const fcName = rel.fromCols && rel.fromCols[0];
  const fromCol = fromT && fcName
    ? fromT.columns.find(c => c.name.toLowerCase() === String(fcName).toLowerCase())
    : null;
  const oneToOne = !!(fromCol && (fromCol.unique || fromCol.pk));
  const mandatory = !!(fromCol && (fromCol.nn || fromCol.pk));
  return {
    from: oneToOne ? 'one' : 'many',        // child (FK) side
    to: mandatory ? 'one' : 'zero-or-one',  // parent (referenced) side
    label: oneToOne ? 'one-to-one' : 'one-to-many',
  };
}
