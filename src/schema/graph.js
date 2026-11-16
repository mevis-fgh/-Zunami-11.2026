import {
  getNamedType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isLeafType,
  isObjectType,
  isScalarType,
  isUnionType,
} from 'graphql';

/**
 * Строит внутренний граф схемы: типы, поля, аргументы, связи.
 * Именно по нему считается покрытие и рисуется UI.
 *
 * @param {import('graphql').GraphQLSchema} schema
 */
export function buildSchemaGraph(schema) {
  const typeMap = schema.getTypeMap();
  const roots = {
    query: schema.getQueryType()?.name || null,
    mutation: schema.getMutationType()?.name || null,
    subscription: schema.getSubscriptionType()?.name || null,
  };
  const rootNames = new Set(Object.values(roots).filter(Boolean));

  /** @type {any[]} */
  const types = [];
  /** @type {any[]} */
  const edges = [];
  /** @type {string[]} */
  const fieldKeys = [];
  /** @type {string[]} */
  const argKeys = [];
  /** @type {string[]} */
  const inputKeys = [];
  /** @type {string[]} */
  const compositeTypes = [];

  for (const name of Object.keys(typeMap).sort()) {
    if (name.startsWith('__')) continue;
    const type = typeMap[name];
    const base = {
      name,
      description: type.description || '',
      isRoot: rootNames.has(name),
    };

    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = Object.values(type.getFields()).map((field) => {
        const named = getNamedType(field.type);
        const args = field.args.map((arg) => ({
          name: arg.name,
          type: String(arg.type),
          description: arg.description || '',
          defaultValue: arg.defaultValue === undefined ? undefined : JSON.stringify(arg.defaultValue),
        }));
        return {
          name: field.name,
          type: String(field.type),
          namedType: named.name,
          description: field.description || '',
          deprecated: Boolean(field.deprecationReason),
          deprecationReason: field.deprecationReason || undefined,
          args,
        };
      });

      compositeTypes.push(name);
      for (const field of fields) {
        fieldKeys.push(`${name}.${field.name}`);
        for (const arg of field.args) argKeys.push(`${name}.${field.name}.${arg.name}`);
        edges.push({
          from: name,
          to: field.namedType,
          field: field.name,
          leaf: isLeafType(getNamedType(type.getFields()[field.name].type)),
        });
      }
      types.push({
        ...base,
        kind: isObjectType(type) ? 'OBJECT' : 'INTERFACE',
        interfaces: isObjectType(type) ? type.getInterfaces().map((item) => item.name) : [],
        fields,
        fieldsCount: fields.length,
      });
      continue;
    }

    if (isUnionType(type)) {
      const possibleTypes = type.getTypes().map((item) => item.name);
      types.push({ ...base, kind: 'UNION', possibleTypes, fields: [], fieldsCount: 0 });
      continue;
    }

    if (isEnumType(type)) {
      const values = type.getValues().map((value) => ({
        name: value.name,
        description: value.description || '',
        deprecated: Boolean(value.deprecationReason),
      }));
      types.push({ ...base, kind: 'ENUM', values, fields: [], fieldsCount: 0 });
      continue;
    }

    if (isInputObjectType(type)) {
      const fields = Object.values(type.getFields()).map((field) => ({
        name: field.name,
        type: String(field.type),
        namedType: getNamedType(field.type).name,
        description: field.description || '',
        defaultValue: field.defaultValue === undefined ? undefined : JSON.stringify(field.defaultValue),
      }));
      for (const field of fields) inputKeys.push(`${name}.${field.name}`);
      types.push({ ...base, kind: 'INPUT_OBJECT', fields, fieldsCount: fields.length, isInput: true });
      continue;
    }

    if (isScalarType(type)) {
      types.push({ ...base, kind: 'SCALAR', fields: [], fieldsCount: 0 });
    }
  }

  const count = (kind) => types.filter((type) => type.kind === kind).length;

  return {
    roots,
    types,
    edges,
    fieldKeys,
    argKeys,
    inputKeys,
    compositeTypes,
    stats: {
      types: types.length,
      objectTypes: count('OBJECT'),
      interfaces: count('INTERFACE'),
      unions: count('UNION'),
      enums: count('ENUM'),
      inputObjects: count('INPUT_OBJECT'),
      scalars: count('SCALAR'),
      fields: fieldKeys.length,
      args: argKeys.length,
      inputFields: inputKeys.length,
      edges: edges.length,
    },
  };
}

/**
 * Компактная сводка графа для списков/селектов.
 * @param {any} graph
 */
export function graphSummary(graph) {
  if (!graph) return null;
  return {
    roots: graph.roots,
    stats: graph.stats,
  };
}
