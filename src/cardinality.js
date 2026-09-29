
export function relationCardinality(relation, tablesByKey) {
  const fromTable = tablesByKey.get(relation.fromKey ?? relation.fromTable.toLowerCase());
  const columnName = relation.fromCols?.[0];
  const columnKey = relation.fromColumnKeys?.[0];
  const fromColumn = fromTable && columnName
    ? fromTable.columns.find(column => {
      const matches = columnKey !== undefined
        ? column.key === columnKey
        : column.name.toLowerCase() === String(columnName).toLowerCase();
      const matchesVersion = relation.change === 'removed'
        ? column.change !== 'added'
        : column.change !== 'removed';
      return matches && matchesVersion;
    })
    : null;
  const oneToOne = !!(fromColumn && (fromColumn.unique || fromColumn.pk));
  const mandatory = !!(fromColumn && (fromColumn.nn || fromColumn.pk));
  return {
    from: oneToOne ? 'one' : 'many',        // child (FK) side
    to: mandatory ? 'one' : 'zero-or-one',  // parent (referenced) side
    label: oneToOne ? 'one-to-one' : 'one-to-many',
  };
}
