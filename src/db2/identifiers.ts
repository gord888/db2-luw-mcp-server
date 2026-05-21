export function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/^"+|"+$/g, '').toUpperCase();
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qualifyTable(schema: string, table: string): string {
  return `${quoteIdentifier(normalizeIdentifier(schema))}.${quoteIdentifier(normalizeIdentifier(table))}`;
}
