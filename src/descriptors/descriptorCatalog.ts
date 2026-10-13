import { access, readFile } from 'node:fs/promises';
import yaml from 'yaml';
import { z } from 'zod/v4';

import { AppError } from '../errors/AppError.js';
import type { DescriptorCatalogDocument, DescriptorRelationship, TableDescriptor } from './descriptorTypes.js';

const descriptorDocumentSchema = z.object({
  tables: z.array(z.object({
    schema: z.string().min(1),
    table: z.string().min(1),
    businessName: z.string().optional(),
    description: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    owner: z.string().optional(),
    sensitivity: z.string().optional(),
    importantColumns: z.array(z.object({
      name: z.string().min(1),
      description: z.string().min(1)
    })).optional(),
    relationships: z.array(z.object({
      target: z.string().min(1),
      type: z.string().min(1),
      join: z.string().min(1),
      description: z.string().optional()
    })).optional(),
    exampleQuestions: z.array(z.string()).optional(),
    exampleQueries: z.array(z.object({
      name: z.string().min(1),
      sql: z.string().min(1)
    })).optional()
  })).optional()
});

function normalizeIdentifier(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '').toUpperCase();
}

function buildKey(schema: string, table: string): string {
  return `${normalizeIdentifier(schema)}.${normalizeIdentifier(table)}`;
}

export class DescriptorCatalog {
  private readonly tableMap: Map<string, TableDescriptor>;

  public constructor(tables: TableDescriptor[]) {
    this.tableMap = new Map(tables.map((table) => [buildKey(table.schema, table.table), table]));
  }

  public static empty(): DescriptorCatalog {
    return new DescriptorCatalog([]);
  }

  public getTable(schema: string, table: string): TableDescriptor | undefined {
    return this.tableMap.get(buildKey(schema, table));
  }

  public async mergeFromFiles(files: string[]): Promise<void> {
    await loadDescriptorFiles(files, this.tableMap);
  }

  public searchBusinessTerms(query: string): TableDescriptor[] {
    const needle = query.trim().toUpperCase();

    if (!needle) {
      return [];
    }

    return [...this.tableMap.values()].filter((table) => {
      const fields = [
        table.businessName,
        table.description,
        ...(table.aliases ?? []),
        ...(table.exampleQuestions ?? []),
        ...(table.importantColumns ?? []).map((column) => `${column.name} ${column.description}`)
      ].filter((field): field is string => Boolean(field));

      return fields.some((field) => field.toUpperCase().includes(needle));
    });
  }

  public listJoinHints(fromSchema: string, fromTable: string, toSchema: string, toTable: string): DescriptorRelationship[] {
    const fromDescriptor = this.getTable(fromSchema, fromTable);
    const toKey = buildKey(toSchema, toTable);

    return (fromDescriptor?.relationships ?? []).filter((relationship) => normalizeTarget(relationship.target, toSchema, toTable) === toKey);
  }
}

function normalizeTarget(target: string, toSchema?: string, toTable?: string): string {
  const parts = target.split('.', 2);
  const schema = parts[0] ?? '';
  const table = parts[1];

  if (!table) {
    // Unqualified target — qualify it using available context
    if (toSchema) {
      return buildKey(toSchema, schema);
    }
    return target.toUpperCase();
  }

  return buildKey(schema, table);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadDescriptorFiles(files: string[], targetMap?: Map<string, TableDescriptor>): Promise<Map<string, TableDescriptor>> {
  const tableMap = targetMap ?? new Map<string, TableDescriptor>();

  for (const filePath of files) {
    if (!(await fileExists(filePath))) {
      continue;
    }

    const fileContent = await readFile(filePath, 'utf8');
    let parsedDocument: DescriptorCatalogDocument;

    try {
      parsedDocument = yaml.parse(fileContent) as DescriptorCatalogDocument;
    } catch (error) {
      throw new AppError('CONFIG_INVALID', `Descriptor file ${filePath} could not be parsed.`, 500, error);
    }

    const validated = descriptorDocumentSchema.safeParse(parsedDocument);
    if (!validated.success) {
      throw new AppError('CONFIG_INVALID', `Descriptor file ${filePath} is invalid.`, 500, validated.error.flatten());
    }

    for (const table of (validated.data.tables ?? [])) {
      tableMap.set(buildKey(table.schema, table.table), table);
    }
  }

  return tableMap;
}

export async function loadDescriptorCatalog(files: string[]): Promise<DescriptorCatalog> {
  if (files.length === 0) {
    return DescriptorCatalog.empty();
  }

  const tableMap = await loadDescriptorFiles(files);
  return new DescriptorCatalog([...tableMap.values()]);
}
