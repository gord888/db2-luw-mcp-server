export interface DescriptorImportantColumn {
  name: string;
  description: string;
}

export interface DescriptorRelationship {
  target: string;
  type: string;
  join: string;
  description?: string;
}

export interface DescriptorExampleQuery {
  name: string;
  sql: string;
}

export interface TableDescriptor {
  schema: string;
  table: string;
  businessName?: string;
  description?: string;
  aliases?: string[];
  owner?: string;
  sensitivity?: string;
  importantColumns?: DescriptorImportantColumn[];
  relationships?: DescriptorRelationship[];
  exampleQuestions?: string[];
  exampleQueries?: DescriptorExampleQuery[];
}

export interface DescriptorCatalogDocument {
  tables?: TableDescriptor[];
}
