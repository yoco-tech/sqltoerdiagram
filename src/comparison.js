import { parseSchema } from './parser.js';

/** Returns a read-only union of two SQL schemas, retaining removed objects. */
export function compareSchemas(previousSql, sql) {
  const previous = parseSchema(previousSql, { qualifiedNames: true });
  const current = parseSchema(sql, { qualifiedNames: true });
  const previousTables = new Map(previous.tables.map(table => [table.key, table]));
  const currentTables = new Map(current.tables.map(table => [table.key, table]));
  const tables = current.tables.map(table => {
    const before = previousTables.get(table.key);
    if (!before) {
      return markTable(table, 'added');
    }
    const previousColumns = new Map(before.columns.map(column => [column.key, column]));
    const currentColumns = new Map(table.columns.map(column => [column.key, column]));
    const columns = [];
    for (const column of table.columns) {
      const oldColumn = previousColumns.get(column.key);
      if (!oldColumn) {
        columns.push({ ...column, change: 'added' });
      } else if (columnSignature(oldColumn) !== columnSignature(column)) {
        columns.push({ ...oldColumn, change: 'removed' }, { ...column, change: 'added' });
      } else {
        columns.push({ ...column });
      }
    }
    for (const column of before.columns) {
      if (!currentColumns.has(column.key)) {
        const previousIndex = before.columns.indexOf(column);
        const following = before.columns.slice(previousIndex + 1).find(candidate => currentColumns.has(candidate.key));
        const insertionIndex = following ? columns.findIndex(candidate => candidate.key === following.key) : columns.length;
        columns.splice(insertionIndex, 0, { ...column, change: 'removed' });
      }
    }
    return { ...table, columns };
  });
  for (const table of previous.tables) {
    if (!currentTables.has(table.key)) {
      tables.push(markTable(table, 'removed'));
    }
  }

  const previousRelations = new Map(previous.relations.map(relation => [relationSignature(relation), relation]));
  const currentRelations = new Map(current.relations.map(relation => [relationSignature(relation), relation]));
  const relations = [...currentRelations].map(([key, relation]) => ({
    ...relation,
    change: previousRelations.has(key) ? undefined : 'added',
  }));
  for (const [key, relation] of previousRelations) {
    if (!currentRelations.has(key)) {
      relations.push({ ...relation, change: 'removed' });
    }
  }
  return {
    ...current,
    tables,
    relations,
    errors: [
      ...previous.errors.map(error => `Previous schema: ${error}`),
      ...current.errors.map(error => `New schema: ${error}`),
    ],
    format: 'sql',
    editable: false,
    comparison: true,
  };
}

function markTable(table, change) {
  return { ...table, change, columns: table.columns.map(column => ({ ...column, change })) };
}

function columnSignature(column) {
  return JSON.stringify([
    column.typeSignature, column.pk, column.nn || column.pk, column.unique,
    column.enumValues || [],
  ]);
}

function relationSignature(relation) {
  return JSON.stringify([relation.fromKey, relation.fromColumnKeys, relation.toKey, relation.toColumnKeys]);
}

/** Validates comparison input before changing the current project. */
export function previousSchemaFromProject(project) {
  if (!project || typeof project.sql !== 'string') {
    throw new Error('Project must contain a SQL string');
  }
  if (project.mode === 'diff' || Object.hasOwn(project, 'previousSql')) {
    if (typeof project.previousSql !== 'string') {
      throw new Error('Comparison must contain a previousSql string');
    }
    return project.previousSql;
  }
  return null;
}
