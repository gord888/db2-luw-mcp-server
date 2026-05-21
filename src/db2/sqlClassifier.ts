import { AppError } from '../errors/AppError.js';

export interface SqlClassification {
  normalizedSql: string;
}

const blockedKeywords = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'CALL',
  'IMPORT',
  'LOAD',
  'EXPORT',
  'RUNSTATS',
  'REORG'
];

function sanitizeSql(sql: string): { sanitized: string; hasComment: boolean; hasSemicolon: boolean } {
  let sanitized = '';
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let hasComment = false;
  let hasSemicolon = false;

  while (index < sql.length) {
    const character = sql[index];
    const nextCharacter = sql[index + 1];

    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        sanitized += '\n';
      }
      index += 1;
      continue;
    }

    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && character === '-' && nextCharacter === '-') {
      hasComment = true;
      inLineComment = true;
      index += 2;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && character === '/' && nextCharacter === '*') {
      hasComment = true;
      inBlockComment = true;
      index += 2;
      continue;
    }

    if (character === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      sanitized += ' ';
      index += 1;
      continue;
    }

    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      sanitized += ' ';
      index += 1;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && character === ';') {
      hasSemicolon = true;
    }

    sanitized += inSingleQuote || inDoubleQuote ? ' ' : character;
    index += 1;
  }

  return { sanitized, hasComment, hasSemicolon };
}

export function classifyReadOnlySql(sql: string): SqlClassification {
  const trimmedSql = sql.trim();
  if (!trimmedSql) {
    throw new AppError('VALIDATION_ERROR', 'SQL text is required.', 400);
  }

  const { sanitized, hasComment, hasSemicolon } = sanitizeSql(trimmedSql);
  const normalizedSql = sanitized.toUpperCase();

  if (hasSemicolon) {
    throw new AppError('SQL_TOO_COMPLEX', 'Multiple statements are not allowed.', 400);
  }

  if (hasComment) {
    throw new AppError('SQL_TOO_COMPLEX', 'SQL comments are not allowed in Release 1 queries.', 400);
  }

  if (!/^\s*(SELECT|WITH)\b/.test(normalizedSql)) {
    throw new AppError('SQL_NOT_READONLY', 'Only SELECT and WITH statements are allowed.', 403);
  }

  for (const keyword of blockedKeywords) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(normalizedSql)) {
      throw new AppError('SQL_NOT_READONLY', `Keyword ${keyword} is not allowed in read-only mode.`, 403);
    }
  }

  return { normalizedSql: trimmedSql };
}
