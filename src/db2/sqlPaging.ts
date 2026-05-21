export interface PagingResult<Row> {
  columns: string[];
  rows: Row[];
  rowCount: number;
  limit: number;
  offset: number;
  truncated: boolean;
  nextOffset: number | null;
  warnings: string[];
}

function splitIsolationClause(sql: string): { sql: string; isolationClause: string } {
  const match = sql.match(/\s+(WITH\s+(UR|CS|RS|RR))\s*$/i);

  if (!match) {
    return {
      sql: sql.trim(),
      isolationClause: ''
    };
  }

  return {
    sql: sql.slice(0, match.index).trim(),
    isolationClause: match[1] ?? ''
  };
}

export function normalizeLimit(requestedLimit: number | undefined, maxRows: number, defaultLimit = maxRows): { limit: number; warnings: string[] } {
  const warnings: string[] = [];
  const safeLimit = requestedLimit ?? defaultLimit;

  if (safeLimit > maxRows) {
    warnings.push(`Requested limit ${safeLimit} exceeded the hard maximum of ${maxRows}; capped to ${maxRows}.`);
  }

  return {
    limit: Math.min(Math.max(safeLimit, 1), maxRows),
    warnings
  };
}

export function wrapSqlWithPaging(sql: string, limit: number, offset: number): string {
  const { sql: coreSql, isolationClause } = splitIsolationClause(sql);
  return `SELECT * FROM (${coreSql}) AS MCP_SUBQUERY OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY${isolationClause ? ` ${isolationClause}` : ''}`;
}

export function buildPagingResult<Row extends Record<string, unknown>>(
  rows: Row[],
  limit: number,
  offset: number,
  warnings: string[]
): PagingResult<Row> {
  const truncated = rows.length > limit;
  const trimmedRows = truncated ? rows.slice(0, limit) : rows;

  return {
    columns: Object.keys(trimmedRows[0] ?? {}),
    rows: trimmedRows,
    rowCount: trimmedRows.length,
    limit,
    offset,
    truncated,
    nextOffset: truncated ? offset + limit : null,
    warnings
  };
}
